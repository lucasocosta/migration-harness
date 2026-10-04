import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { listen, close } from './helpers/build-workspace.mjs';
import './helpers/privacy.mjs';

// P7.7 Tier 1 / P7.8 Tier 2 fixture for the api-first pair: REAL persistence on both sides —
// source SQLite through PDO (relational rows), target embedded H2 holding the customer as a
// JSON document — with byte-for-byte behavioral parity. Covers, on BOTH sides:
//   (1) read-after-write across separate requests,
//   (2) invalid input leaves the state unchanged,
//   (3) the declared audit fault (header X-Fault-Phase: audit / field faultPhase=audit) rolls
//       back completely — no customer change, no audit record,
//   (4) the two probes' canonical projections match after identical operations (cross-engine
//       parity: SQLite rows vs H2 documents project to the same domain state),
//   (5) the reset commands restore the identical baseline (probe before/after cycle equal),
// plus the native checks of both sides. Needs php, JDK and Maven; skips cleanly where the
// toolchains are absent. The suite copies the pair to a temp workspace (like
// api-first-acceptance.test.mjs), builds the target, boots both servers on ephemeral ports it
// reserves itself, drives HTTP and runs the declared probe/reset commands; after() tears
// everything down so no port of this suite survives its run.
const exec = promisify(execFile), repo = resolve('.');
const delay = ms => new Promise(done => setTimeout(done, ms));
const isWindows = process.platform === 'win32';
/** Only mvn ships as a .cmd shim on Windows, which Node refuses to spawn without a shell. */
const shellFor = argv => isWindows && argv[0] === 'mvn';

const toolchains = () => [['php', '--version'], ['java', '--version'], ['mvn', '--version']]
  .every(([tool, flag]) => spawnSync(tool, [flag], { encoding: 'utf8', shell: isWindows }).status === 0);

/** One native command: argv only (never an implicit shell), cwd under the copied workspace. */
function tool(cwd, argv) {
  return exec(argv[0], argv.slice(1), {
    cwd, maxBuffer: 32 * 1024 * 1024, shell: shellFor(argv),
  });
}

let world;
const roots = [];
const servers = {};
/**
 * Ephemeral-port reservations this suite still holds open. A port is picked with `listen(0)` and
 * its listener stays bound — so no concurrent run can be handed the same number — until the very
 * moment the real server is about to bind it. Releasing earlier (the TOCTOU window of
 * `build-workspace.mjs`) is what the reservations exist to avoid: the exposure is the few
 * milliseconds between `release()` and the child's `bind`, not the whole fixture setup.
 */
const reservations = new Set();
async function reservePort() {
  const server = await listen(0);
  reservations.add(server);
  return server;
}
const portOf = server => server.address().port;
/** Free one reservation exactly once; the caller keeps the number it already read. */
async function release(server) {
  if (!server || !reservations.delete(server)) return;
  await close(server);
}
const releaseAll = async () => { for (const server of [...reservations]) await release(server); };

const sides = () => ({
  source: { dir: world.sourceDir, port: world.ports.source,
    probe: ['php', 'evaluation/state-probe.php'], reset: ['php', 'reset.php'] },
  target: { dir: world.targetDir, port: world.ports.target,
    probe: ['java', '-cp', 'target/classes', 'com.example.apifirst.StateProbe'],
    reset: ['java', '-cp', 'target/classes', 'com.example.apifirst.Reset'] },
});

async function ensure(t) {
  if (!toolchains()) { t.skip('php/java/mvn toolchains unavailable'); return null; }
  if (world) return world;
  const root = await mkdtemp(join(tmpdir(), 'api-first-persistence-'));
  roots.push(root);
  await cp(join(repo, 'examples/api-first'), join(root, 'examples/api-first'), { recursive: true });
  const sourceDir = join(root, 'examples/api-first/source');
  const targetDir = join(root, 'examples/api-first/java');
  // Disposable output and runtime stores of the copy start empty, like a fresh checkout.
  for (const path of [join(targetDir, 'target'), join(sourceDir, 'data'), join(targetDir, 'data')]) {
    await rm(path, { recursive: true, force: true });
  }
  try {
    await tool(targetDir, ['mvn', '-q', '-DskipTests', 'package']);
  } catch (error) {
    await releaseAll();
    throw new Error(`target build failed:\n${error.stderr ?? error.message}`);
  }
  // Ports are chosen only once the expensive setup is done: each reservation is held until its
  // server is spawned, so a concurrent run never sees a number this suite is about to use.
  const reserved = { source: await reservePort(), target: await reservePort() };
  world = { root, sourceDir, targetDir,
    ports: { source: portOf(reserved.source), target: portOf(reserved.target) },
    reservations: reserved };
  try {
    await startServers();
    // Boot order mirrors the harness: the applications serve first, then the declared reset
    // runs with both servers live (the target probe/reset must reach the store H2 still holds).
    await reset('source');
    await reset('target');
    world.baselineProfile = (await getProfile('source')).body;
    assert.deepEqual((await getProfile('target')).body, world.baselineProfile,
      'both sides serve the same baseline profile after reset');
  } catch (error) {
    // Never leave a half-started world behind: the next test must fail or skip on its own terms.
    await stop(servers.source);
    await stop(servers.target);
    delete servers.source;
    delete servers.target;
    await releaseAll();
    world = undefined;
    throw error;
  }
  return world;
}

async function startServers() {
  servers.source = await startServer(
    ['php', '-S', `127.0.0.1:${world.ports.source}`, '-t', '.', 'index.php'],
    world.sourceDir, world.ports.source, world.reservations.source);
  servers.target = await startServer(
    ['java', '-jar', 'target/api-first-target.jar', `--server.port=${world.ports.target}`],
    world.targetDir, world.ports.target, world.reservations.target);
}

/** Spawn one application and poll its health endpoint until it answers (bounded, diagnostics kept). */
async function startServer(argv, cwd, port, reservation) {
  // Last possible moment to hand the reserved port over to the server that binds it.
  await release(reservation);
  const child = spawn(argv[0], argv.slice(1), {
    cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: shellFor(argv), detached: !isWindows,
  });
  let output = '', spawnError;
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.once('error', error => { spawnError = error; });
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (spawnError) throw new Error(`server on ${port} could not be spawned: ${spawnError.message}`);
    if (child.exitCode !== null) {
      throw new Error(`server on ${port} exited with ${child.exitCode}:\n${output.slice(-4000)}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/profile`, { signal: AbortSignal.timeout(3000) });
      if (response.status === 200) { await response.text(); return child; }
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) {
      await stop(child);
      throw new Error(`server on ${port} never became ready:\n${output.slice(-4000)}`);
    }
    await delay(250);
  }
}

/** Kill the whole server process tree (POSIX group / Windows taskkill) and wait for it to be gone. */
async function stop(child) {
  if (!child || child.exitCode !== null || child.pid === undefined) return;
  const exit = new Promise(done => child.once('exit', done));
  const signal = () => {
    if (isWindows) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
  };
  signal();
  await Promise.race([exit, delay(8000)]);
  if (child.exitCode === null) { signal(); await Promise.race([exit, delay(3000)]); }
  // Release the pipes so a lingering child can never keep the test process alive.
  child.stdout?.destroy();
  child.stderr?.destroy();
}

async function put(side, body, headers = {}) {
  const { port } = sides()[side];
  const response = await fetch(`http://127.0.0.1:${port}/api/customer`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.json() };
}

async function getProfile(side) {
  const { port } = sides()[side];
  const response = await fetch(`http://127.0.0.1:${port}/api/profile`, { signal: AbortSignal.timeout(10_000) });
  return { status: response.status, body: await response.json() };
}

/** Raw stdout of the side's declared probe command: one canonical JSON line. */
async function probeRaw(side) {
  const definition = sides()[side];
  const { stdout } = await tool(definition.dir, definition.probe);
  return stdout;
}

/** The projection as a comparable string (trailing newline dropped, bytes otherwise untouched). */
async function probe(side) {
  return (await probeRaw(side)).trim();
}

async function reset(side) {
  const definition = sides()[side];
  await tool(definition.dir, definition.reset);
}

after(async () => {
  await stop(servers.source);
  await stop(servers.target);
  await releaseAll();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test('api-first persistence: native checks pass on both sides', async t => {
  const w = await ensure(t); if (!w) return;
  const native = [
    [w.sourceDir, ['php', 'build.php']],
    [w.sourceDir, ['php', 'tests/validation-test.php']],
    [w.targetDir, ['java', '-cp', 'target/classes', 'com.example.apifirst.RegressionTest']],
    [w.targetDir, ['java', '-cp', 'target/classes', 'com.example.apifirst.PersistenceTest']],
  ];
  for (const [cwd, argv] of native) {
    try {
      await tool(cwd, argv);
    } catch (error) {
      assert.fail(`${argv.join(' ')} failed:\n${error.stderr ?? error.message}`);
    }
  }
});

test('api-first persistence: a save is read back by later requests on both sides', async t => {
  const w = await ensure(t); if (!w) return;
  for (const side of ['source', 'target']) {
    await reset(side);
    const saved = await put(side, { email: 'roundtrip@example.test' });
    assert.equal(saved.status, 200, `${side}: valid save answers 200`);
    assert.deepEqual(saved.body, { status: 'saved', email: 'roundtrip@example.test' });
    // A separate, later request — not the save response — must carry the persisted value.
    const readBack = await getProfile(side);
    assert.equal(readBack.status, 200);
    assert.deepEqual(readBack.body, { email: 'roundtrip@example.test', name: w.baselineProfile.name });
    const state = JSON.parse(await probe(side));
    assert.equal(state._settle, 'complete', `${side}: projection reports the completion marker`);
    assert.equal(state.audit.count, 1, `${side}: exactly one audit record for one save`);
    assert.equal(state.customers[0].email, 'roundtrip@example.test', `${side}: the customer document/row persists`);
    assert.equal(state.customers[0].fixtureKey, 'default');
  }
});

test('api-first persistence: invalid input leaves the persisted state unchanged on both sides', async t => {
  const w = await ensure(t); if (!w) return;
  for (const side of ['source', 'target']) {
    await reset(side);
    const before = await probe(side);
    const rejected = await put(side, { email: 'not-an-email' });
    assert.equal(rejected.status, 422, `${side}: invalid save answers 422`);
    assert.deepEqual(rejected.body, { error: 'invalid email' });
    assert.equal(await probe(side), before, `${side}: the rejected save changed no persisted state`);
    const baselineCustomer = JSON.parse(before).customers[0];
    assert.deepEqual((await getProfile(side)).body,
      { email: baselineCustomer.email, name: baselineCustomer.name },
      `${side}: the profile still reads the baseline customer`);
  }
});

test('api-first persistence: the injected audit failure rolls back completely on both sides', async t => {
  const w = await ensure(t); if (!w) return;
  for (const side of ['source', 'target']) {
    await reset(side);
    const saved = await put(side, { email: 'kept@example.test' });
    assert.equal(saved.status, 200, `${side}: the pre-fault save succeeds`);
    const before = await probe(side);
    assert.equal(JSON.parse(before).audit.count, 1);

    // Declared trigger 1: request header X-Fault-Phase: audit.
    const headerFault = await put(side, { email: 'faulted@example.test' }, { 'X-Fault-Phase': 'audit' });
    assert.equal(headerFault.status, 500, `${side}: header trigger answers 500`);
    assert.deepEqual(headerFault.body, { error: 'injected failure' });
    assert.equal(await probe(side), before, `${side}: header trigger leaves no partial state`);

    // Declared trigger 2: the documented equivalent the scenario vocabulary can express.
    const fieldFault = await put(side, { email: 'faulted@example.test', faultPhase: 'audit' });
    assert.equal(fieldFault.status, 500, `${side}: faultPhase trigger answers 500`);
    assert.deepEqual(fieldFault.body, { error: 'injected failure' });
    assert.equal(await probe(side), before, `${side}: faultPhase trigger leaves no partial state`);

    const state = JSON.parse(await probe(side));
    assert.equal(state.customers[0].email, 'kept@example.test', `${side}: the customer write was rolled back`);
    assert.equal(state.audit.count, 1, `${side}: no audit record landed for a failed save`);
    assert.deepEqual((await getProfile(side)).body,
      { email: 'kept@example.test', name: w.baselineProfile.name }, `${side}: reads see the rollback`);
    // An invalid email with the fault declared still answers 422 and touches nothing.
    const invalidFault = await put(side, { email: 'not-an-email', faultPhase: 'audit' });
    assert.equal(invalidFault.status, 422, `${side}: validation runs before the store is touched`);
    assert.equal(await probe(side), before, `${side}: invalid+fault still leaves no state`);
  }
});

test('api-first persistence: both probes project the same domain state after identical operations (cross-engine)', async t => {
  const w = await ensure(t); if (!w) return;
  // Identical baseline: a relational sentinel row and a document row must project identically.
  await reset('source');
  await reset('target');
  const sourceBaseline = await probe('source');
  const targetBaseline = await probe('target');
  assert.equal(sourceBaseline, targetBaseline, 'the reset baselines project byte-identically');

  // Identical operations on both sides: one valid save, one rejected save, one injected fault.
  for (const body of [
    { email: 'parity@example.test' },
    { email: 'not-an-email' },
    { email: 'parity@example.test', faultPhase: 'audit' },
  ]) {
    const sourceResult = await put('source', body);
    const targetResult = await put('target', body);
    assert.equal(sourceResult.status, targetResult.status, `same status for ${JSON.stringify(body)}`);
    assert.deepEqual(sourceResult.body, targetResult.body, `same body for ${JSON.stringify(body)}`);
  }

  const sourceState = await probe('source');
  const targetState = await probe('target');
  assert.equal(sourceState, targetState,
    'SQLite rows and H2 JSON documents project to the same canonical domain state');

  // The canonical shape itself: one line, keys sorted at every level, declared fields only.
  const raw = await probeRaw('source');
  assert.equal(raw.trim().split('\n').length, 1, 'the probe prints exactly one JSON line');
  assert.equal(raw.trim(), sourceState);
  const state = JSON.parse(sourceState);
  assert.deepEqual(Object.keys(state), ['_settle', 'audit', 'customers']);
  assert.deepEqual(Object.keys(state.audit), ['count']);
  assert.deepEqual(Object.keys(state.customers[0]), ['email', 'fixtureKey', 'name']);
  assert.equal(state._settle, 'complete');
  assert.equal(state.audit.count, 1, 'the rejected save and the faulted save added no audit record');
  assert.equal(state.customers[0].email, 'parity@example.test');
});

test('api-first persistence: the reset commands restore the identical baseline on both sides', async t => {
  const w = await ensure(t); if (!w) return;
  for (const side of ['source', 'target']) {
    await reset(side);
    const before = await probe(side);
    await put(side, { email: 'mutated@example.test' });
    const mutated = await probe(side);
    assert.notEqual(mutated, before, `${side}: the mutation is observable`);
    await reset(side);
    const after = await probe(side);
    assert.equal(after, before, `${side}: reset restores the identical synthetic baseline`);
    assert.equal(JSON.parse(after)._settle, 'complete');
  }
  // After independent resets the two engines start from equivalent initial domain state.
  await reset('source');
  await reset('target');
  assert.equal(await probe('source'), await probe('target'), 'both sides reset to one shared baseline');
  assert.deepEqual((await getProfile('target')).body, w.baselineProfile);
});
