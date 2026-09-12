import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HOOK = resolve('scripts/copilot-boundary-hook.mjs');

const workspace = async () => {
  const root = await mkdtemp(join(tmpdir(), 'copilot-hook-'));
  const home = join(root, 'home');
  await mkdir(join(home, '.local/state/migration-harness/abc/raw'), { recursive: true });
  await mkdir(join(root, 'migrations/cliente'), { recursive: true });
  await mkdir(join(root, 'artifacts/cliente/unit'), { recursive: true });
  await mkdir(join(root, 'apps/react/src/features'), { recursive: true });
  await mkdir(join(root, 'packages/core/src'), { recursive: true });
  await writeFile(join(root, 'AGENTS.md'), '# protocol\n');
  const brief = {
    kind: 'TRANSFORM_BRIEF',
    briefId: `b_${'a'.repeat(64)}`,
    allowedFiles: [{ path: 'src/features/CustomerProfile.tsx', sha256: 'a'.repeat(64), exists: false }],
    contextFiles: [join(root, 'apps/react/src/components/Button.tsx')],
    submission: {
      command: `apply-patch --brief ${join(root, 'artifacts/cliente/unit/brief.json')} --candidate-root ${join(root, 'apps/react')} --artifact-root ${join(root, 'artifacts/cliente/unit')} --input <submission.json> --out <apply-result.json>`,
    },
  };
  await writeFile(join(root, 'artifacts/cliente/unit/brief.json'), JSON.stringify(brief));
  return { root, home };
};

const run = (root, home, phase, payload, extraEnv = {}) => {
  const result = spawnSync(process.execPath, [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, HARNESS_REPO_ROOT: root, HARNESS_PHASE: phase, HARNESS_HOOK_LOG: 'artifacts/hook.log', ...extraEnv },
  });
  assert.equal(result.status, 0, result.stderr);
  const stdout = result.stdout.trim();
  if (!stdout) return { decision: 'pass' };
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  return { decision: parsed.hookSpecificOutput.permissionDecision, reason: parsed.hookSpecificOutput.permissionDecisionReason };
};

const read = path => ({ tool_name: 'readFile', tool_input: { filePath: path } });
const write = path => ({ tool_name: 'editFiles', tool_input: { files: [path] } });
const shell = command => ({ tool_name: 'runInTerminal', tool_input: { command } });

test('boundary hook fails closed on unusable input and unknown phase', async () => {
  const { root, home } = await workspace();
  try {
    assert.equal(run(root, home, 'transformation', 'not json').decision, 'deny');
    assert.equal(run(root, home, '', read(join(root, 'AGENTS.md'))).decision, 'deny');
    assert.equal(run(root, home, 'auditing', read(join(root, 'AGENTS.md'))).decision, 'deny');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('private artifacts, private state root and secrets are refused in both phases', async () => {
  const { root, home } = await workspace();
  try {
    for (const phase of ['preparation', 'transformation']) {
      for (const path of [
        join(root, '.migration-private/raw/unit/scenario/0.json'),
        join(home, '.local/state/migration-harness/abc/raw/0.json'),
        join(root, 'apps/react/.env'),
        join(root, 'apps/react/keys/service.pem'),
      ]) {
        assert.equal(run(root, home, phase, read(path)).decision, 'deny', `${phase} ${path}`);
      }
      assert.equal(run(root, home, phase, shell(`cat ${join(root, '.migration-private/raw/x.json')}`)).decision, 'deny');
    }
    // A tilde form and a file:// URI must normalize to the same refusal.
    assert.equal(run(root, home, 'preparation', read('~/.local/state/migration-harness/abc/raw/0.json')).decision, 'deny');
    assert.equal(run(root, home, 'preparation', read(`file://${join(root, '.migration-private/raw/0.json')}`)).decision, 'deny');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('preparation writes only tracking files and never executes commands', async () => {
  const { root, home } = await workspace();
  try {
    assert.equal(run(root, home, 'preparation', write(join(root, 'migrations/cliente/units.md'))).decision, 'pass');
    assert.equal(run(root, home, 'preparation', write(join(root, 'apps/react/src/features/CustomerProfile.tsx'))).decision, 'deny');
    assert.equal(run(root, home, 'preparation', write(join(root, 'packages/core/src/brief.ts'))).decision, 'deny');
    assert.equal(run(root, home, 'preparation', write(join(root, 'AGENTS.md'))).decision, 'deny');
    assert.equal(run(root, home, 'preparation', shell('pnpm build')).decision, 'deny');
    // Broad reads stay available: the specification authorizes them, not the hook.
    assert.equal(run(root, home, 'preparation', read(join(root, 'apps/react/src/features/CustomerProfile.tsx'))).decision, 'pass');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('transformation without an issued brief denies every tool call', async () => {
  const { root, home } = await workspace();
  try {
    const result = run(root, home, 'transformation', read(join(root, 'AGENTS.md')));
    assert.equal(result.decision, 'deny');
    assert.match(result.reason, /sem fronteira emitida/);
    await writeFile(join(root, '.harness-brief-path'), 'artifacts/cliente/unit/missing.json\n');
    assert.equal(run(root, home, 'transformation', read(join(root, 'AGENTS.md'))).decision, 'deny');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('transformation reads only the issued boundary', async () => {
  const { root, home } = await workspace();
  try {
    await writeFile(join(root, '.harness-brief-path'), 'artifacts/cliente/unit/brief.json\n');
    const pass = [
      join(root, 'artifacts/cliente/unit/brief.json'),
      join(root, 'AGENTS.md'),
      join(root, 'apps/react/src/features/CustomerProfile.tsx'),
      join(root, 'apps/react/src/components/Button.tsx'),
      join(root, 'artifacts/cliente/unit/verify-1.json'),
    ];
    for (const path of pass) assert.equal(run(root, home, 'transformation', read(path)).decision, 'pass', path);
    const deny = [
      join(root, 'apps/react/src/features/OtherFeature.tsx'),
      join(root, 'apps/react/package.json'),
      join(root, 'packages/core/src/brief.ts'),
      join(root, 'migrations/cliente/SPEC.md'),
    ];
    for (const path of deny) assert.equal(run(root, home, 'transformation', read(path)).decision, 'deny', path);
    assert.match(run(root, home, 'transformation', read(join(root, 'apps/react/package.json'))).reason, /contextFiles/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('transformation writes only a submission JSON and never the candidates', async () => {
  const { root, home } = await workspace();
  try {
    await writeFile(join(root, '.harness-brief-path'), 'artifacts/cliente/unit/brief.json\n');
    assert.equal(run(root, home, 'transformation', write(join(root, 'artifacts/cliente/unit/submission.json'))).decision, 'pass');
    const candidate = run(root, home, 'transformation', write(join(root, 'apps/react/src/features/CustomerProfile.tsx')));
    assert.equal(candidate.decision, 'deny');
    assert.match(candidate.reason, /apply-patch/);
    assert.equal(run(root, home, 'transformation', write(join(root, 'artifacts/cliente/unit/notes.md'))).decision, 'deny');
    assert.equal(run(root, home, 'transformation', write(join(root, 'migrations/cliente/units.md'))).decision, 'deny');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('transformation allows harness verification commands but refuses oracle and publish acts', async () => {
  const { root, home } = await workspace();
  try {
    await writeFile(join(root, '.harness-brief-path'), 'artifacts/cliente/unit/brief.json\n');
    const allowed = [
      `node packages/cli/dist/index.js apply-patch --brief ${join(root, 'artifacts/cliente/unit/brief.json')} --candidate-root ${join(root, 'apps/react')} --input ${join(root, 'artifacts/cliente/unit/submission.json')} --out ${join(root, 'artifacts/cliente/unit/apply-1.json')}`,
      'node packages/cli/dist/index.js run --max-repairs 0 --out artifacts/cliente/unit/verify-1.json',
      'npm --prefix apps/react run build',
      'git -C apps/react status --short',
    ];
    for (const command of allowed) assert.equal(run(root, home, 'transformation', shell(command)).decision, 'pass', command);
    const refused = [
      'node packages/cli/dist/index.js approve-contract --input c.json --approved-by me --out a.json',
      'node packages/cli/dist/index.js synthesize --unit-id U --input t.json --out d.json',
      'node packages/cli/dist/index.js trace --scenario s.json --base-url http://localhost:4200',
      'node packages/cli/dist/index.js rotate-raw-key --store-root artifacts --audit audit.json',
      'node packages/cli/dist/index.js import-test-evidence --input report.json --out e.json',
      'node packages/cli/dist/index.js sanitize-trace --input raw.json --out s.json',
      'git -C apps/react commit -m "migração"',
      'git -C apps/react push -u origin migration/customer-profile',
    ];
    for (const command of refused) assert.equal(run(root, home, 'transformation', shell(command)).decision, 'deny', command);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('every decision is appended to the boundary log as evidence', async () => {
  const { root, home } = await workspace();
  try {
    await writeFile(join(root, '.harness-brief-path'), 'artifacts/cliente/unit/brief.json\n');
    run(root, home, 'transformation', read(join(root, 'AGENTS.md')));
    run(root, home, 'transformation', read(join(root, 'packages/core/src/brief.ts')));
    const lines = (await readFile(join(root, 'artifacts/hook.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map(line => line.decision), ['pass', 'deny']);
    assert.ok(lines.every(line => line.phase === 'transformation' && typeof line.at === 'string'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
