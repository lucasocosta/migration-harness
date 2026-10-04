/**
 * Drift guards for the two contracts this cache mirrors instead of owning: the effective
 * environment of a project command (`project-checks.execute`) and the preflight input hash.
 * If either source changes without this module, these tests fail before a stale identity can
 * ever produce a hit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { effectiveCommandEnv, BUILD_CACHE_ENV_KEYS, projectInputHash } from '../packages/engine/dist/build-cache.js';
import { preflightProjectChecks } from '../packages/engine/dist/project-checks.js';
import { buildWorkspace, write } from './helpers/build-workspace.mjs';

const source = fileURLToPath(new URL('../packages/engine/src/project-checks.ts', import.meta.url));

test('the effective command environment mirrors the spawn contract of project-checks', async () => {
  const text = await readFile(source, 'utf8');
  const constants = /const env: NodeJS\.ProcessEnv = \{([^}]*)\}/.exec(text);
  assert.ok(constants, 'project-checks declares the scrubbed environment of a command');
  const declared = constants[1].split(',').map(part => part.trim()).filter(Boolean)
    .map(part => /^([A-Z_]+):\s*'([^']*)'$/.exec(part.trim())).filter(Boolean)
    .map(match => [match[1], match[2]]);
  assert.deepEqual(declared.sort((left, right) => left[0] < right[0] ? -1 : 1),
    Object.entries(effectiveCommandEnv({})).sort((left, right) => left[0] < right[0] ? -1 : 1),
    'the constants of the identity match the constants actually spawned');

  const keys = /for \(const key of \[([^\]]+)\]/.exec(text);
  assert.ok(keys, 'project-checks forwards an explicit environment allowlist');
  const forwarded = keys[1].split(',').map(part => part.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual(forwarded, [...BUILD_CACHE_ENV_KEYS],
    'every forwarded variable joins the cache identity, and only those');

  const env = { PATH: '/usr/bin', HOME: '/home/runner', LANG: 'pt-BR', SECRET_TOKEN: 'never' };
  const effective = effectiveCommandEnv(env);
  assert.deepEqual(Object.keys(effective).sort(), ['CI', 'HOME', 'LANG', 'NO_COLOR', 'PATH'].sort());
  assert.equal('SECRET_TOKEN' in effective, false, 'the identity never collects arbitrary variables');
});

test('the cache input hash mirrors the preflight input hash', async t => {
  const { root, config } = await buildWorkspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  await write(root, 'source/assets/data.json', '{"rows":[]}');

  const before = await preflightProjectChecks({ config, workspaceRoot: root });
  assert.equal(before.status, 'PASS');
  assert.equal(await projectInputHash(config, root), before.inputHash, 'identical formula over identical inputs');

  await write(root, 'source/main.ts', 'export const value = 7;\n');
  const after = await preflightProjectChecks({ config, workspaceRoot: root });
  assert.equal(await projectInputHash(config, root), after.inputHash, 'both move together on a change');
  assert.notEqual(after.inputHash, before.inputHash);
  assert.equal(await projectInputHash(config, root), after.inputHash);

  // A change outside the declared relevantFiles is invisible to both — that is why the identity
  // of this cache also walks the whole project, while the report keeps using this hash.
  await write(root, 'source/assets/data.json', '{"rows":[1]}');
  assert.equal(await projectInputHash(config, root), after.inputHash);
});
