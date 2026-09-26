import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MigrationReportInputSchema, MigrationReportSchema, PrivacyModeSchema, MigrationDiagnosticSchema,
} from '../packages/core/dist/migration-report.js';
import { ProjectPreflightSchema } from '../packages/core/dist/project-check.js';

const identity = {
  migrationId: 'a'.repeat(32),
  configurationHash: 'b'.repeat(64),
  referenceHash: 'c'.repeat(64),
  candidateHash: 'd'.repeat(64),
  buildHash: 'e'.repeat(64),
};

test('privacy disclosure codes are valid diagnostics and may accompany PASS', () => {
  const parsed = MigrationDiagnosticSchema.parse({ code: 'WEAK_PRIVATE_PERMISSIONS', detailCode: 'WINDOWS_NO_POSIX_MODES' });
  assert.equal(parsed.code, 'WEAK_PRIVATE_PERMISSIONS');
  const degraded = MigrationDiagnosticSchema.parse({ code: 'DEGRADED_ISOLATION' });
  assert.equal(degraded.code, 'DEGRADED_ISOLATION');
});

test('MigrationReport requires privacy disclosure when mode is DEGRADED_INSECURE', () => {
  const base = {
    kind: 'MIGRATION_REPORT', version: '1', identity, evaluatedAt: '2026-01-01T00:00:00.000Z',
    status: 'INCONCLUSIVE', preservation: 'INCONCLUSIVE', requirements: 'NOT_APPLICABLE', projectChecks: 'INCONCLUSIVE',
    referenceStatus: 'DECLARED',
    requiredCoverage: {
      scenarios: { expected: 0, received: 0 },
      requirements: { expected: 0, received: 0 },
      checks: { expected: 0, received: 0 },
    },
    diagnostics: [], scenarios: [], checks: [],
  };
  assert.equal(MigrationReportSchema.safeParse({ ...base, privacy: { mode: 'DEGRADED_INSECURE', platform: 'win32' } }).success, false);
  assert.equal(MigrationReportSchema.safeParse({
    ...base,
    privacy: { mode: 'DEGRADED_INSECURE', platform: 'win32' },
    diagnostics: [{ code: 'WEAK_PRIVATE_PERMISSIONS' }, { code: 'DEGRADED_ISOLATION' }],
  }).success, true);
  assert.equal(MigrationReportSchema.safeParse({ ...base, privacy: { mode: 'STRICT', platform: 'linux' } }).success, true);
});

test('PASS may carry privacy disclosures; other diagnostics still contradict PASS', () => {
  const base = {
    identity, evaluatedAt: '2026-01-01T00:00:00.000Z', referenceVerified: true,
    scenarios: [{
      identity, scenarioId: 'a'.repeat(32), status: 'PASS', requirements: [], evidencePaths: [],
      diagnostics: [{ code: 'WEAK_PRIVATE_PERMISSIONS' }, { code: 'DEGRADED_ISOLATION' }],
    }],
    checks: [],
  };
  assert.equal(MigrationReportInputSchema.safeParse(base).success, true);
  assert.equal(MigrationReportInputSchema.safeParse({
    ...base,
    scenarios: [{ ...base.scenarios[0], diagnostics: [{ code: 'BEHAVIOR_DIVERGENCE' }] }],
  }).success, false);
});

test('preflight disclosures may accompany PASS without findings', () => {
  const base = {
    kind: 'PROJECT_PREFLIGHT', version: '1', migrationId: 'a'.repeat(32),
    configurationHash: 'b'.repeat(64), workspaceHash: 'c'.repeat(64),
    status: 'PASS', inputHash: 'd'.repeat(64), findings: [],
    disclosures: [{ code: 'WEAK_PRIVATE_PERMISSIONS', detailCode: 'WINDOWS_NO_POSIX_MODES' }],
  };
  assert.equal(ProjectPreflightSchema.safeParse(base).success, true);
  // Blocking findings still force INCONCLUSIVE.
  assert.equal(ProjectPreflightSchema.safeParse({
    ...base, findings: [{ code: 'UNSUPPORTED_PLATFORM' }],
  }).success, false);
});

test('PrivacyModeSchema is strict', () => {
  assert.equal(PrivacyModeSchema.safeParse({ mode: 'STRICT', platform: 'linux' }).success, true);
  assert.equal(PrivacyModeSchema.safeParse({ mode: 'NOPE', platform: 'linux' }).success, false);
});
