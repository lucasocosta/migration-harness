import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import { parseMigrationConfig } from '../../packages/core/dist/index.js';
import { prepareMigration, startMigrationSession, verifyMigrationSession, inspectMigrationSession, migrationSessionPath } from '../../packages/engine/dist/index.js';

const exec = promisify(execFile);

test('published component-first example verifies both dependent units in one standard session', async t => {
  let probe;
  try { probe = await chromium.launch({ headless: true }); }
  catch { return t.skip('Chromium is unavailable'); }
  finally { await probe?.close(); }

  // Copy beneath the repository so esbuild resolves the installed framework
  // dependencies, without editing the example or reusing a developer's session.
  const root = await mkdtemp(resolve('artifacts/component-first-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp('examples/component-first', join(root, 'examples/component-first'), {
    recursive: true, filter: path => !path.split('/').includes('dist'),
  });
  const config = parseMigrationConfig(JSON.parse(await readFile(join(root, 'examples/component-first/migration.json'), 'utf8')));
  const input = { config, workspaceRoot: root, allowProjectCommands: true };
  const preparation = await prepareMigration({ ...input, artifactPath: 'artifacts/prepared' });
  assert.equal(preparation.status, 'PASS');
  await startMigrationSession({ ...input, preparation });
  const result = await verifyMigrationSession(input);
  assert.equal(result.decision, 'COMPLETE');
  assert.equal(result.report.status, 'PASS');
  assert.deepEqual(result.report.requiredCoverage, {
    scenarios: { expected: 5, received: 5 },
    requirements: { expected: 11, received: 11 },
    checks: { expected: 3, received: 3 },
  });
  assert.ok(result.report.scenarios.every(scenario => scenario.status === 'PASS'));
  const status = await inspectMigrationSession(input);
  assert.equal(status.attemptsUsed, 1);
  assert.equal(status.referenceStatus, 'VERIFIED');
  assert.equal(status.lastReportMatchesWorkspace, true);

  // A new process must also observe the durable result from this exact example.
  await writeFile(join(root, 'config.json'), JSON.stringify(config));
  const cli = await exec(process.execPath, [resolve('packages/cli/dist/index.js'), 'migration-session-status',
    '--config', join(root, 'config.json'), '--workspace-root', root]);
  assert.equal(JSON.parse(cli.stdout).lastReportMatchesWorkspace, true);
  assert.equal(JSON.parse(cli.stdout).sessionPath, migrationSessionPath(config));
});
