import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const cli = resolve('packages/cli/dist/index.js');

async function run(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], { reject: false });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code ?? 1 };
  }
}

test('--json prints full engine-shaped objects and text mode stays the default', async t => {
  const root = await mkdtemp(join(tmpdir(), 'harness-json-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = {
    kind: 'MIGRATION_CONFIG', version: '1', migrationId: 'json-demo',
    source: {
      root: 'apps/angular', baseUrl: 'http://localhost:4200', relevantFiles: ['src/page.ts'],
      commands: [{ id: 'build', kind: 'build', argv: ['npm', 'run', 'build'], cwd: '.', timeoutMs: 60000 }],
    },
    target: {
      root: 'apps/react', baseUrl: 'http://localhost:5173', relevantFiles: ['src/page.tsx'], writePaths: ['src/page.tsx'], protectedPaths: [],
      commands: [{ id: 'build', kind: 'build', argv: ['npm', 'run', 'build'], cwd: '.', timeoutMs: 60000 }],
    },
    scenarios: [{
      definition: {
        scenarioId: 'save', unitId: 'customer', name: 'Save', description: 'Save',
        entryUrl: 'http://localhost:4200/c', preconditions: {}, testDataProfile: 'standard',
        steps: [{ stepId: 'save', action: 'click', targetRole: 'button', targetName: 'Save' }],
      },
      required: true, fixtureRoot: 'migrations/customer/scenarios/fixtures',
      bindings: {
        source: { entryUrl: 'http://localhost:4200/c', steps: [] },
        target: { entryUrl: 'http://localhost:5173/c', steps: [{ stepId: 'save', targetRole: 'button', targetName: 'Salvar' }] },
      },
    }],
    checks: [{ id: 'target-build', side: 'target', commandId: 'build', required: true }],
    requirements: [], acceptedDifferences: [], policy: {}, reset: { kind: 'ISOLATED_FIXTURES' },
    environment: { browser: 'chromium', locale: 'pt-BR', viewport: { width: 1280, height: 720 } },
    limits: { sourceRuns: 2, maxRepairAttempts: 2, maxDurationMs: 600000 },
    profile: 'standard',
  };
  await mkdir(join(root, 'apps/angular'), { recursive: true });
  await mkdir(join(root, 'apps/react'), { recursive: true });
  await writeFile(join(root, 'migration.json'), JSON.stringify(config, null, 2));

  const jsonRun = await run([
    'prepare-migration', '--config', join(root, 'migration.json'), '--workspace-root', root,
    '--artifact-path', 'artifacts/prepared', '--preflight-only', '--json',
  ]);
  const parsed = JSON.parse(jsonRun.stdout);
  assert.ok(parsed.kind === 'MIGRATION_PREPARATION' || parsed.kind === 'MIGRATION_PREFLIGHT', parsed.kind);
  assert.ok('status' in parsed);

  const textRun = await run([
    'prepare-migration', '--config', join(root, 'migration.json'), '--workspace-root', root,
    '--artifact-path', 'artifacts/prepared2', '--preflight-only',
  ]);
  assert.ok(textRun.stdout.length > 0);
  assert.ok(!textRun.stdout.trimStart().startsWith('{'), 'text mode is not JSON by default');
});
