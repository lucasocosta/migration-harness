import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { handleRequest, serveStdio } from '../packages/mcp-server/dist/index.js';
import { publicPath, readPublicJson } from '../packages/mcp-server/dist/public-io.js';
import { canonical, migrationConfigHash, migrationReferenceHash } from '../packages/core/dist/index.js';
import { collectMigrationReference } from '../packages/engine/dist/migration-reference.js';
import { runProjectChecks } from '../packages/engine/dist/project-checks.js';
import { startMigrationSession, migrationSessionPath } from '../packages/engine/dist/migration-session.js';
import { buildWorkspace, write } from './helpers/build-workspace.mjs';
import { canCreateSymlink } from './helpers/privacy.mjs';

const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const toolsCall = (name, args) => handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
const backslashes = path => path.split('/').join('\\');

test('mcp refuses config and preparation symlinks that resolve into private storage', async t => {
  if (!await canCreateSymlink()) return t.skip('symlinks unavailable on this host');
  const root = await mkdtemp(join(tmpdir(), 'mcp-boundary-symlink-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secret = 'RAW_PRIVATE_FILE_CONTENT_4f2c';
  await mkdir(join(root, '.migration-private'), { recursive: true });
  await writeFile(join(root, '.migration-private', 'store.json'), JSON.stringify({ secret }));
  const { config } = await buildWorkspace();
  await write(root, 'migration.json', JSON.stringify(config));
  const storeFile = join(root, '.migration-private', 'store.json');
  await symlink(storeFile, join(root, 'config-link.json'));
  await symlink(storeFile, join(root, 'preparation-link.json'));

  const viaConfig = await toolsCall('inspect_migration_session', { configPath: join(root, 'config-link.json'), workspaceRoot: root });
  assert.equal(viaConfig.error?.code, -32000);
  assert.equal(viaConfig.error.message, 'ASSISTANT_CHANNEL_PRIVATE_PATH:config-path');
  const configText = JSON.stringify(viaConfig);
  assert.ok(!configText.includes(secret), 'no raw file content in the response');
  assert.ok(!configText.includes('.migration-private'), 'no private path in the response');

  const viaPreparation = await toolsCall('verify_migration', {
    configPath: join(root, 'migration.json'), workspaceRoot: root,
    preparationPath: join(root, 'preparation-link.json'), artifactPath: 'artifacts/standalone',
  });
  assert.equal(viaPreparation.error?.code, -32000);
  assert.equal(viaPreparation.error.message, 'ASSISTANT_CHANNEL_PRIVATE_PATH:preparation-path');
  const preparationText = JSON.stringify(viaPreparation);
  assert.ok(!preparationText.includes(secret), 'no raw file content in the response');
  assert.ok(!preparationText.includes('.migration-private'), 'no private path in the response');
});

test('mcp refuses private state-dir paths under env overrides and windows separators', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-boundary-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, 'state-root');
  await mkdir(stateRoot, { recursive: true });
  const secret = 'STATE_DIR_RAW_CONTENT_9b1d';
  const secretPath = join(stateRoot, 'secret.json');
  await writeFile(secretPath, JSON.stringify({ secret }));
  const previous = process.env.MIGRATION_HARNESS_STATE_DIR;
  process.env.MIGRATION_HARNESS_STATE_DIR = stateRoot;
  t.after(() => {
    if (previous === undefined) delete process.env.MIGRATION_HARNESS_STATE_DIR;
    else process.env.MIGRATION_HARNESS_STATE_DIR = previous;
  });

  // The path carries no private marker substring: only the state-dir override catches it.
  const direct = await toolsCall('inspect_migration_session', { configPath: secretPath, workspaceRoot: root });
  assert.equal(direct.error?.code, -32000);
  assert.equal(direct.error.message, 'ASSISTANT_CHANNEL_PRIVATE_PATH:config-path');
  assert.ok(!JSON.stringify(direct).includes(secret), 'no raw file content in the response');

  const windows = await toolsCall('inspect_migration_session', { configPath: backslashes(secretPath), workspaceRoot: root });
  assert.equal(windows.error?.code, -32000);
  assert.equal(windows.error.message, 'ASSISTANT_CHANNEL_PRIVATE_PATH:config-path');
  assert.ok(!JSON.stringify(windows).includes(secret), 'no raw file content in the response');

  await assert.rejects(publicPath(backslashes(secretPath), 'config-path'), /ASSISTANT_CHANNEL_PRIVATE_PATH:config-path/);
  await assert.rejects(publicPath('C:\\Users\\dev\\.migration-private\\config.json', 'config-path'), /ASSISTANT_CHANNEL_PRIVATE_PATH:config-path/);
  await assert.rejects(readPublicJson(secretPath, 'config-path'), /ASSISTANT_CHANNEL_PRIVATE_PATH:config-path/);
});

test('mcp answers unknown tools and methods with stable codes and hides raw read errors', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-boundary-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const unknownTool = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'probe.migration-private.tool', arguments: {} } });
  assert.equal(unknownTool.error?.code, -32602);
  assert.equal(unknownTool.error.message, 'UNKNOWN_TOOL');
  assert.ok(!JSON.stringify(unknownTool).includes('migration-private'), 'unknown tool name is not reflected');

  const unknownMethod = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'debug.migration-private.method' });
  assert.equal(unknownMethod.error?.code, -32601);
  assert.equal(unknownMethod.error.message, 'METHOD_NOT_FOUND');
  assert.ok(!JSON.stringify(unknownMethod).includes('migration-private'), 'unknown method name is not reflected');

  const missing = await toolsCall('inspect_migration_session', { configPath: join(root, 'missing-config.json'), workspaceRoot: root });
  assert.equal(missing.error?.code, -32000);
  assert.equal(missing.error.message, 'INPUT_FILE_MISSING:config-path');
  const text = JSON.stringify(missing);
  assert.ok(!text.includes('ENOENT'), 'no errno text leaks');
  assert.ok(!text.includes('missing-config.json'), 'no path content leaks');
});

test('mcp verify_migration honors session budgets and refuses profile downgrade', async t => {
  const { root, config } = await buildWorkspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  config.profile = 'standard';
  const configPath = join(root, 'migration.json');
  await write(root, 'migration.json', JSON.stringify(config));
  const input = { config, workspaceRoot: root };

  // Standard profile without a session never reaches a standalone (budget-free) verifier.
  const noSession = await toolsCall('verify_migration', { configPath, workspaceRoot: root, allowProjectCommands: true });
  assert.equal(noSession.error?.code, -32000);
  assert.equal(noSession.error.message, 'STANDARD_SESSION_REQUIRED');
  assert.equal(noSession.result, undefined, 'no verification result without a session');

  // Caller-selected preparation/output are refused before any read.
  const selected = await toolsCall('verify_migration', {
    configPath, workspaceRoot: root, preparationPath: join(root, 'prepared.json'),
    artifactPath: 'artifacts/bypass', allowProjectCommands: true,
  });
  assert.equal(selected.error?.message, 'STANDARD_SESSION_OWNS_REFERENCE_AND_OUTPUT');

  // Non-standard profile without a session keeps exactly the CLI-gated standalone path.
  const plain = { ...config };
  delete plain.profile;
  await write(root, 'migration.json', JSON.stringify(plain));
  const missingPreparation = await toolsCall('verify_migration', { configPath, workspaceRoot: root, allowProjectCommands: true });
  assert.equal(missingPreparation.error?.message, 'MISSING_PREPARATION_PATH');
  await write(root, 'migration.json', JSON.stringify(config));

  // With a session, verify_migration routes through the persistent attempt budgets.
  const reference = await collectMigrationReference({ ...input, sourceObservations: { status: 'STABLE', runs: 2, executionHashes: [digest('source'), digest('source')] } });
  const baseline = await runProjectChecks({ ...input, phase: 'baseline', allowProjectCommands: true });
  const preparation = { kind: 'MIGRATION_PREPARATION', version: '1', status: 'PASS', reference, referenceHash: migrationReferenceHash(reference), artifactPath: 'artifacts/prepared', keyId: digest('dummy'), sourceEvidence: [], baseline, sourceBuild: { kind: 'SERVED_BUILD', version: '1', side: 'source', runId: randomUUID(), origin: config.source.baseUrl, configurationHash: migrationConfigHash(config), inputHash: digest('input'), buildHash: digest('build'), fileCount: 1, totalBytes: 1 } };
  await startMigrationSession({ ...input, preparation });
  await journal(root, config, [1, 1, 1, 1]);
  const stopped = await toolsCall('verify_migration', { configPath, workspaceRoot: root, allowProjectCommands: true });
  assert.ok(stopped.result, `expected a session result, got ${JSON.stringify(stopped.error)}`);
  const payload = JSON.parse(stopped.result.content[0].text);
  assert.equal(payload.kind, 'MIGRATION_SESSION_RESULT');
  assert.equal(payload.decision, 'STOP_LIMIT');
  assert.equal(payload.attemptsUsed, 4);
  assert.equal(payload.report, undefined, 'no standalone report bypasses the stopped session');

  // An existing session refuses a profile downgrade instead of one-shot verification.
  const downgraded = { ...config };
  delete downgraded.profile;
  await write(root, 'migration.json', JSON.stringify(downgraded));
  const refusal = await toolsCall('verify_migration', { configPath, workspaceRoot: root, allowProjectCommands: true });
  assert.equal(refusal.error?.code, -32000);
  assert.equal(refusal.error.message, 'STANDARD_SESSION_PROFILE_REQUIRED');
});

/** Hash-linked attempt journal for a session budget, as recorded by the harness itself. */
async function journal(root, config, durations) {
  const sessionPath = migrationSessionPath(config);
  const envelope = JSON.parse(await readFile(join(root, sessionPath, 'session.json'), 'utf8'));
  let previousHash = envelope.hash;
  for (let index = 0; index < durations.length; index++) {
    const prefix = `${sessionPath}/attempts/${String(index).padStart(4, '0')}`;
    const start = {
      index, startedAt: new Date().toISOString(), previousHash, candidateHash: digest(`candidate-${index}`),
      remainingMs: config.limits.maxDurationMs - durations.slice(0, index).reduce((sum, value) => sum + value, 0),
    };
    await write(root, `${prefix}.started.json`, JSON.stringify(start));
    const finish = {
      index, startHash: digest(start), finishedAt: new Date().toISOString(), durationMs: durations[index],
      outcome: 'INCONCLUSIVE', fingerprint: digest('mcp-journal'), candidateHash: start.candidateHash,
      findings: [], errorCode: 'SYNTHETIC_FAILURE',
    };
    await write(root, `${prefix}.finished.json`, JSON.stringify(finish));
    previousHash = digest(finish);
  }
}

test('mcp refuses the real spelling of a private file behind a symlinked state dir', async t => {
  if (!await canCreateSymlink()) return t.skip('symlinks unavailable on this host');
  const root = await mkdtemp(join(tmpdir(), 'mcp-boundary-alias-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateReal = join(root, 'state-real');
  const stateAlias = join(root, 'state-alias');
  await mkdir(stateReal, { recursive: true });
  const secret = 'ALIAS_STATE_RAW_CONTENT_5a8f';
  await writeFile(join(stateReal, 'secret.json'), JSON.stringify({ secret }));
  await writeFile(join(root, 'public.json'), JSON.stringify({ public: true }));
  await symlink(stateReal, stateAlias);
  const previous = process.env.MIGRATION_HARNESS_STATE_DIR;
  process.env.MIGRATION_HARNESS_STATE_DIR = stateAlias;
  t.after(() => {
    if (previous === undefined) delete process.env.MIGRATION_HARNESS_STATE_DIR;
    else process.env.MIGRATION_HARNESS_STATE_DIR = previous;
  });

  // The override names the alias; the request names the real directory it points at: no
  // private marker substring and no lexical overlap with the alias, so only the canonical
  // spelling of the root catches it.
  const viaReal = await toolsCall('inspect_migration_session', { configPath: join(stateReal, 'secret.json'), workspaceRoot: root });
  assert.equal(viaReal.error?.code, -32000);
  assert.equal(viaReal.error.message, 'ASSISTANT_CHANNEL_PRIVATE_PATH:config-path');
  const text = JSON.stringify(viaReal);
  assert.ok(!text.includes(secret), 'no raw file content in the response');
  assert.ok(!text.includes('state-real'), 'the private path is not reflected');
  await assert.rejects(publicPath(join(stateReal, 'secret.json'), 'config-path'), /ASSISTANT_CHANNEL_PRIVATE_PATH:config-path/);
  await assert.rejects(publicPath(join(stateAlias, 'secret.json'), 'config-path'), /ASSISTANT_CHANNEL_PRIVATE_PATH:config-path/);
  await assert.rejects(readPublicJson(join(stateReal, 'secret.json'), 'config-path'), /ASSISTANT_CHANNEL_PRIVATE_PATH:config-path/);

  // The root screen stays bounded: files outside the state root still read.
  assert.deepEqual(await readPublicJson(join(root, 'public.json'), 'public-file'), { public: true });
});

test('mcp rejects object-valued ids instead of reflecting private markers', async () => {
  // The id is never screened field-by-field: the whole envelope must fail validation and
  // a fixed payload with id null is the only answer — nothing of the object comes back.
  const poisoned = await handleRequest({ jsonrpc: '2.0', id: { marker: '.migration-private' }, method: 'tools/list' });
  assert.deepEqual(poisoned, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'INVALID_REQUEST' } });
  assert.ok(!JSON.stringify(poisoned).includes('migration-private'), 'the object id is not reflected anywhere');

  const badMethod = await handleRequest({ jsonrpc: '2.0', id: 4, method: { name: '.migration-private' } });
  assert.deepEqual(badMethod, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'INVALID_REQUEST' } });

  const badParams = await handleRequest({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: 'p_0123456789abcdef01234567' });
  assert.deepEqual(badParams, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'INVALID_REQUEST' } });

  // A valid envelope still answers; only the poisoned string id is screened to null.
  const screened = await handleRequest({ jsonrpc: '2.0', id: '.migration-private', method: 'tools/list' });
  assert.equal(screened.id, null);
  assert.ok(Array.isArray(screened.result.tools));
  assert.ok(!JSON.stringify(screened).includes('migration-private'));
});

test('mcp keeps serving after malformed requests and garbage lines', async () => {
  const nullRequest = await handleRequest(null);
  assert.deepEqual(nullRequest, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'INVALID_REQUEST' } });

  // The same server still answers a valid request after the malformed one.
  const valid = await handleRequest({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
  assert.equal(valid.id, 7);
  assert.ok(Array.isArray(valid.result.tools), 'valid requests still succeed');

  // Over stdio: an unparseable line and a non-object line both answer INVALID_REQUEST,
  // and the next valid request on the same stream still gets its response.
  const input = new Readable({ read() {} });
  input.push('this is not json{\n');
  input.push('42\n');
  input.push(`${JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' })}\n`);
  input.push(null);
  const chunks = [];
  const output = new Writable({
    write(chunk, encoding, callback) { chunks.push(String(chunk)); callback(); },
  });
  await serveStdio(input, output);
  const responses = chunks.join('').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses.length, 3, 'both bad lines answered and the next request served');
  assert.deepEqual(responses[0], { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'INVALID_REQUEST' } });
  assert.deepEqual(responses[1], { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'INVALID_REQUEST' } });
  assert.equal(responses[2].id, 8);
  assert.ok(Array.isArray(responses[2].result.tools));
});
