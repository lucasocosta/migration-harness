import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../packages/engine/dist/index.js';
import { openPublicFile, publicFile, publicPath, readPublicJson } from '../packages/cli/dist/assistant-files.js';
import { canCreateSymlink } from './helpers/privacy.mjs';

/**
 * Restauração de cobertura (auditoria final P1): o dono `tests/har-import-boundary.test.mjs` morreu
 * no kill switch §8.2 junto com o comando `import-har`, mas o leitor assistant-facing sobrevive em
 * `packages/cli/src/assistant-files.ts` e é o canal de ingestão de config/preparation/report das
 * rotas CLI v2. O gêmeo MCP (`packages/mcp-server/src/public-io.ts`) é coberto por mcp-boundary; o
 * leitor CLI tinha ficado sem teste — em especial o binding dev/ino de `openPublicFile`, que nega
 * troca de objeto entre validação e abertura. Estes asserts são a restauração, não expansão.
 */

const withStateDir = async (root, run) => {
  const previous = process.env.MIGRATION_HARNESS_STATE_DIR;
  process.env.MIGRATION_HARNESS_STATE_DIR = root;
  try { await run(); } finally {
    if (previous === undefined) delete process.env.MIGRATION_HARNESS_STATE_DIR;
    else process.env.MIGRATION_HARNESS_STATE_DIR = previous;
  }
};

test('cli public reader refuses private roots: literal, symlinked and state-dir override', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cli-public-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ArtifactStore(join(root, 'artifacts'));

  // Literal `.migration-private` segment: refused in the lexical spelling, before any read.
  const literal = join(root, '.migration-private', 'config.json');
  await assert.rejects(publicPath(literal, store), /private artifact domain/);
  await assert.rejects(readPublicJson(literal, store), /private artifact domain/);

  // A public-looking alias whose canonical spelling lands in the private domain is refused too.
  if (await canCreateSymlink()) {
    await mkdir(join(root, '.migration-private'), { recursive: true });
    await writeFile(join(root, '.migration-private', 'config.json'), JSON.stringify({ secret: true }));
    await symlink(join(root, '.migration-private'), join(root, 'alias'));
    await assert.rejects(publicPath(join(root, 'alias', 'config.json'), store), /private artifact domain/);
  }

  // The private state-dir override is private in both spellings, even with no private marker.
  const state = join(root, 'state-root');
  await mkdir(state, { recursive: true });
  await writeFile(join(state, 'secret.json'), JSON.stringify({ secret: true }));
  await withStateDir(state, async () => {
    await assert.rejects(publicPath(join(state, 'secret.json'), store), /private artifact domain/);
    await assert.rejects(readPublicJson(join(state, 'secret.json'), store), /private artifact domain/);
  });

  // The screen stays bounded: a public file still reads.
  await writeFile(join(root, 'public.json'), JSON.stringify({ public: true }));
  assert.deepEqual(await readPublicJson(join(root, 'public.json'), store), { public: true });
});

test('public reads bind the opened object to the validated identity and refuse swaps', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cli-public-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ArtifactStore(join(root, 'artifacts'));
  const dir = join(root, 'evidence'), path = join(dir, 'bundle.json'), hidden = join(root, '.migration-private');
  await mkdir(dir, { recursive: true });
  await mkdir(hidden, { recursive: true });
  await writeFile(path, JSON.stringify({ ok: true }));
  // Leaf swap: a distinct object (created alongside the validated one, so never its inode) takes
  // the validated spelling; the descriptor no longer names the captured dev/ino.
  const validated = await publicFile(path, store);
  await writeFile(join(hidden, 'bundle.json'), JSON.stringify({ ok: false }));
  await rename(join(hidden, 'bundle.json'), path);
  await assert.rejects(openPublicFile(validated), /changed during access/);
  assert.deepEqual(await readPublicJson(path, store), { ok: false }, 'the next validation reads the new object');

  // Ancestor swap: the parent becomes a symlink into the private domain after validation, so the
  // descriptor would follow it; the repeated canonical check refuses before any byte is read. The
  // CLI now performs that public-domain recheck at open (union of guarantees with the MCP reader),
  // so this swap is refused as a private path rather than only as a changed identity.
  const fresh = await publicFile(path, store);
  await writeFile(join(hidden, 'bundle.json'), JSON.stringify({ stolen: true }));
  await rename(dir, join(root, 'evidence-moved'));
  await symlink(hidden, dir);
  await assert.rejects(openPublicFile(fresh), /private artifact domain/);
  await unlink(dir);
  await rename(join(root, 'evidence-moved'), dir);
  assert.deepEqual(await readPublicJson(path, store), { ok: false }, 'the validated public file still reads once restored');
});
