import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../packages/engine/dist/index.js';
import {
  openPublicFile as cliOpenPublicFile, publicFile as cliPublicFile,
  publicPath as cliPublicPath, readPublicJson as cliReadPublicJson,
} from '../packages/cli/dist/assistant-files.js';
import {
  openPublicFile as mcpOpenPublicFile, publicFile as mcpPublicFile,
  publicPath as mcpPublicPath, readPublicJson as mcpReadPublicJson,
} from '../packages/mcp-server/dist/public-io.js';
import { canCreateSymlink } from './helpers/privacy.mjs';

/**
 * Conformidade compartilhada da fronteira de IO público (PLAN-V2 §2.2, auditoria final P2).
 *
 * Uma única matriz de propriedades roda contra os DOIS adapters de canal:
 *  - CLI   (`packages/cli/src/assistant-files.ts`, sobre o `ArtifactStore`, vocabulário de prosa);
 *  - MCP   (`packages/mcp-server/src/public-io.ts`, sem store, vocabulário estável de tool-args).
 *
 * Onde a política é comum, os dois recusam/aceitam o mesmo objeto (união das garantias:
 * separadores, marcadores, private-root literal/symlink/state-dir, reconferência na abertura,
 * binding dev/ino). As duas diferenças legítimas — raízes configuráveis do store (só CLI) e
 * vocabulário de recusa (só MCP) — são provadas explicitamente, não deixadas implícitas.
 *
 * Este arquivo não substitui `tests/public-io-boundary.test.mjs` nem `tests/mcp-boundary.test.mjs`:
 * os asserts de contrato daqueles canais continuam; aqui a matriz prova a paridade entre eles.
 */

const backslashes = path => path.split('/').join('\\');

const withStateDir = async (root, run) => {
  const previous = process.env.MIGRATION_HARNESS_STATE_DIR;
  process.env.MIGRATION_HARNESS_STATE_DIR = root;
  try { await run(); } finally {
    if (previous === undefined) delete process.env.MIGRATION_HARNESS_STATE_DIR;
    else process.env.MIGRATION_HARNESS_STATE_DIR = previous;
  }
};

/** The channel under test, behind one interface so the matrix is written once. */
const cliSurface = store => ({
  name: 'cli',
  path: path => cliPublicPath(path, store),
  file: path => cliPublicFile(path, store),
  open: file => cliOpenPublicFile(file),
  read: (path, maxBytes) => cliReadPublicJson(path, store, maxBytes),
  privateRe: /private artifact domain/,
  changedRe: /changed during access/,
});

const mcpSurface = () => ({
  name: 'mcp',
  path: path => mcpPublicPath(path, 'config-path'),
  file: path => mcpPublicFile(path, 'config-path'),
  open: file => mcpOpenPublicFile(file, 'config-path'),
  read: (path, maxBytes) => mcpReadPublicJson(path, 'config-path', maxBytes),
  privateRe: /ASSISTANT_CHANNEL_PRIVATE_PATH:config-path/,
  changedRe: /INPUT_FILE_CHANGED:config-path/,
});

/** Every read entry point must refuse the same private candidate, each in its own vocabulary. */
async function assertRefusedByAll(surface, path, reason) {
  await assert.rejects(surface.path(path), surface.privateRe, `${surface.name} publicPath ${reason}`);
  await assert.rejects(surface.file(path), surface.privateRe, `${surface.name} publicFile ${reason}`);
  await assert.rejects(surface.read(path), surface.privateRe, `${surface.name} readPublicJson ${reason}`);
}

test('cli and mcp public surfaces enforce the same private-root union', async t => {
  const root = await mkdtemp(join(tmpdir(), 'public-io-conformance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, 'state-root');
  await mkdir(stateRoot, { recursive: true });
  await mkdir(join(root, '.migration-private'), { recursive: true });
  await writeFile(join(root, '.migration-private', 'secret.json'), JSON.stringify({ secret: true }));
  await writeFile(join(stateRoot, 'secret.json'), JSON.stringify({ secret: true }));
  const stateBody = JSON.stringify({ secret: true });

  await withStateDir(stateRoot, async () => {
    const store = new ArtifactStore(join(root, 'artifacts'));
    const surfaces = [cliSurface(store), mcpSurface()];

    // 1. Literal `.migration-private` segment, refused before any read by both channels.
    for (const surface of surfaces) {
      await assertRefusedByAll(surface, join(root, '.migration-private', 'config.json'), 'literal private segment');
    }

    // 2. Private marker substrings that are not a segment of the private domain: the CLI reader
    //    now filters the full marker vocabulary, not only the `.migration-private` segment.
    for (const markerPath of [
      join(root, 'migration-harness-private', 'config.json'),
      join(root, '.local', 'state', 'migration-harness', 'config.json'),
    ]) {
      for (const surface of surfaces) await assertRefusedByAll(surface, markerPath, 'private marker substring');
    }

    // 3. The private state-dir override has no private marker: only the state root catches it.
    for (const surface of surfaces) {
      await assertRefusedByAll(surface, join(stateRoot, 'secret.json'), 'state-dir override');
    }

    // 4. Windows separator spellings are normalized before the screen on both channels.
    for (const surface of surfaces) {
      await assertRefusedByAll(surface, backslashes(join(stateRoot, 'secret.json')), 'windows separators on state dir');
    }
    for (const surface of surfaces) {
      await assertRefusedByAll(surface, 'C:\\Users\\dev\\.migration-private\\config.json', 'windows private segment');
    }

    // 5. A public file still reads on both channels (the screen stays bounded).
    const publicPath = join(root, 'public.json');
    await writeFile(publicPath, JSON.stringify({ public: true }));
    for (const surface of surfaces) {
      assert.deepEqual(await surface.read(publicPath), { public: true }, `${surface.name} reads a public file`);
    }

    // 6. Output path: a not-yet-existing public path is still validated where it would land; the
    //    same non-existing path under a private root is refused.
    for (const surface of surfaces) {
      const target = await surface.path(join(root, 'output', 'not-created.json'));
      assert.equal(typeof target, 'string', `${surface.name} returns a target for a future output path`);
      await assert.rejects(surface.path(join(stateRoot, 'not-created.json')), surface.privateRe, `${surface.name} refuses a future private output path`);
    }

    // 7. Symlinked private roots: the alias into `.migration-private` is refused, whether named by
    //    the alias or the directory it points at, and so is an override that names the symlink.
    if (await canCreateSymlink()) {
      await symlink(join(root, '.migration-private'), join(root, 'alias'));
      await assertRefusedByAll(cliSurface(store), join(root, 'alias', 'config.json'), 'symlinked private alias');
      await assertRefusedByAll(mcpSurface(), join(root, 'alias', 'config.json'), 'symlinked private alias');

      const stateReal = join(root, 'state-real');
      const stateAlias = join(root, 'state-alias');
      await mkdir(stateReal, { recursive: true });
      await writeFile(join(stateReal, 'secret.json'), stateBody);
      await symlink(stateReal, stateAlias);
      await withStateDir(stateAlias, async () => {
        const aliasedStore = new ArtifactStore(join(root, 'artifacts-alias'));
        await assertRefusedByAll(cliSurface(aliasedStore), join(stateReal, 'secret.json'), 'real spelling behind symlinked state dir');
        await assertRefusedByAll(mcpSurface(), join(stateReal, 'secret.json'), 'real spelling behind symlinked state dir');
      });
    }
  });
});

test('both public surfaces bind the opened object to the validated dev/ino', async t => {
  const root = await mkdtemp(join(tmpdir(), 'public-io-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hidden = join(root, '.migration-private');
  await mkdir(hidden, { recursive: true });
  const stateRoot = join(root, 'state-root');
  await mkdir(stateRoot, { recursive: true });

  await withStateDir(stateRoot, async () => {
    const store = new ArtifactStore(join(root, 'artifacts'));
    const surfaces = [cliSurface(store), mcpSurface()];

    for (const surface of surfaces) {
      // Leaf swap: a distinct object takes the validated spelling; the descriptor no longer names
      // the captured dev/ino, so both channels refuse before reading a byte.
      const dir = join(root, `evidence-${surface.name}`);
      const path = join(dir, 'bundle.json');
      await mkdir(dir, { recursive: true });
      await writeFile(path, JSON.stringify({ ok: true }));
      const validated = await surface.file(path);
      await writeFile(join(hidden, `bundle-${surface.name}.json`), JSON.stringify({ ok: false }));
      await rename(join(hidden, `bundle-${surface.name}.json`), path);
      await assert.rejects(surface.open(validated), surface.changedRe, `${surface.name} refuses a replaced leaf`);
      assert.deepEqual(await surface.read(path), { ok: false }, `${surface.name} re-validates and reads the new object`);

      // Ancestor swap into the private domain: the canonical recheck at open refuses the swapped
      // ancestor, so the union of the CLI recheck and the MCP recheck now holds on both channels.
      const fresh = await surface.file(path);
      await writeFile(join(hidden, 'bundle.json'), JSON.stringify({ stolen: true }));
      await rename(dir, `${dir}-moved`);
      await symlink(hidden, dir);
      await assert.rejects(surface.open(fresh), surface.privateRe, `${surface.name} rechecks the public domain at open`);
      await unlink(dir);
      await rename(`${dir}-moved`, dir);
      assert.deepEqual(await surface.read(path), { ok: false }, `${surface.name} reads the validated public file once restored`);
    }
  });
});

test('the two legitimate differences stay parametric: configured store roots and refusal vocabulary', async t => {
  const root = await mkdtemp(join(tmpdir(), 'public-io-parametric-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, 'state-root');
  await mkdir(stateRoot, { recursive: true });
  const storePrivate = join(root, 'store-private');
  const storeBackup = join(root, 'store-backup');
  await mkdir(join(storePrivate, 'keys'), { recursive: true });
  await mkdir(storeBackup, { recursive: true });
  await writeFile(join(storePrivate, 'custom.json'), JSON.stringify({ secret: true }));
  await writeFile(join(storePrivate, 'keys', 'v1.hex'), JSON.stringify({ secret: true }));
  await writeFile(join(storeBackup, 'gen-1.json'), JSON.stringify({ secret: true }));

  await withStateDir(stateRoot, async () => {
    // The CLI reader carries the store's configured private/keys/backup roots; the MCP channel has
    // no store, so those roots are not part of its private set. Both are separate from the state
    // root and carry no private marker, so this is exactly the parametric divergence.
    const store = new ArtifactStore(join(root, 'artifacts'), storePrivate, { backup: { root: storeBackup } });
    const cli = cliSurface(store);
    const mcp = mcpSurface();

    await assertRefusedByAll(cli, join(storePrivate, 'custom.json'), 'configured privateRoot');
    await assertRefusedByAll(cli, join(storePrivate, 'keys', 'v1.hex'), 'configured keysRoot');
    await assertRefusedByAll(cli, join(storeBackup, 'gen-1.json'), 'configured backup root');

    assert.deepEqual(await mcp.read(join(storePrivate, 'custom.json')), { secret: true }, 'mcp has no configured store roots');
    assert.deepEqual(await mcp.read(join(storePrivate, 'keys', 'v1.hex')), { secret: true }, 'mcp has no configured keys root');
    assert.deepEqual(await mcp.read(join(storeBackup, 'gen-1.json')), { secret: true }, 'mcp has no configured backup root');

    // The refusal vocabulary is the second parameter: MCP names the tool-argument label, the CLI
    // keeps its prose. Both are refusals for the same private candidate, spelled differently.
    const privateCandidate = join(root, '.migration-private', 'config.json');
    await assert.rejects(cli.path(privateCandidate), /private artifact domain/);
    await assert.rejects(mcpPublicPath(privateCandidate, 'tool-args'), /ASSISTANT_CHANNEL_PRIVATE_PATH:tool-args/);
    await assert.rejects(mcpPublicPath(privateCandidate, 'config-path'), /ASSISTANT_CHANNEL_PRIVATE_PATH:config-path/);
  });
});
