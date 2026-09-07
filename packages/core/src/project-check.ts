import { z } from 'zod';
import { MigrationIdSchema, Sha256Schema } from './migration-config.js';
import { VerificationStatusSchema } from './migration-report.js';

const issue = z.object({
  code: z.enum(['INPUT_UNAVAILABLE', 'CWD_UNAVAILABLE', 'UNSUPPORTED_PLATFORM', 'EXECUTION_NOT_AUTHORIZED',
    'INPUT_CHANGED', 'BASELINE_MISMATCH', 'ABORTED']),
  checkId: MigrationIdSchema.optional(),
}).strict();
export const ProjectPreflightSchema = z.object({
  kind: z.literal('PROJECT_PREFLIGHT'), version: z.literal('1'), migrationId: MigrationIdSchema,
  configurationHash: Sha256Schema, workspaceHash: Sha256Schema,
  status: z.enum(['PASS', 'INCONCLUSIVE']), inputHash: Sha256Schema.optional(),
  findings: z.array(issue),
}).strict().refine(value => value.status === 'PASS'
  ? value.findings.length === 0 && value.inputHash !== undefined : value.findings.length > 0,
'Preflight status contradicts findings');
export const NativeCheckResultSchema = z.object({
  checkId: MigrationIdSchema, commandId: MigrationIdSchema, side: z.enum(['source', 'target']),
  required: z.boolean(), commandHash: Sha256Schema,
  status: VerificationStatusSchema,
  reason: z.enum(['COMPLETED', 'EXIT_NONZERO', 'SPAWN_FAILED', 'TIMEOUT', 'OUTPUT_LIMIT', 'ABORTED', 'CLEANUP_FAILED', 'NOT_RUN']),
  exitCode: z.number().int().nullable(), durationMs: z.number().int().nonnegative(),
  output: z.object({ omitted: z.literal(true), stdoutBytes: z.number().int().nonnegative(), stderrBytes: z.number().int().nonnegative() }).strict(),
  baselineComparison: z.enum(['BASELINE', 'NOT_COMPARED', 'NEW_CHECK_FAILURE', 'BASELINE_CHECK_FAILED', 'RESOLVED', 'UNCHANGED']),
}).strict().superRefine((value, ctx) => {
  const expected = value.reason === 'COMPLETED' ? 'PASS' : value.reason === 'EXIT_NONZERO' ? 'FAIL' : 'INCONCLUSIVE';
  if (value.status !== expected || value.reason === 'COMPLETED' && value.exitCode !== 0
    || value.reason === 'EXIT_NONZERO' && (value.exitCode === null || value.exitCode === 0)) {
    ctx.addIssue({ code: 'custom', message: 'Native check result contradicts its process outcome' });
  }
});
export const ProjectCheckReportSchema = z.object({
  kind: z.literal('PROJECT_CHECK_REPORT'), version: z.literal('1'),
  migrationId: MigrationIdSchema, configurationHash: Sha256Schema, workspaceHash: Sha256Schema,
  phase: z.enum(['baseline', 'candidate']), evaluatedAt: z.string().datetime({ offset: true }),
  status: VerificationStatusSchema, preflight: ProjectPreflightSchema,
  inputHashAfter: Sha256Schema.optional(), findings: z.array(issue),
  checks: z.array(NativeCheckResultSchema),
}).strict().superRefine((value, ctx) => {
  const invalid = (): void => ctx.addIssue({ code: 'custom', message: 'Project report contradicts its checks or preflight' });
  if (new Set(value.checks.map(item => item.checkId)).size !== value.checks.length) invalid();
  if (value.configurationHash !== value.preflight.configurationHash || value.workspaceHash !== value.preflight.workspaceHash
    || value.migrationId !== value.preflight.migrationId) invalid();
  const required = value.checks.filter(item => item.required);
  if (value.status === 'PASS' && (!required.length || required.some(item => item.status !== 'PASS')
    || value.preflight.status !== 'PASS' || value.findings.length || value.inputHashAfter !== value.preflight.inputHash)) invalid();
  if (value.status === 'FAIL' && !required.some(item => item.status === 'FAIL')) invalid();
});
export type ProjectPreflight = z.infer<typeof ProjectPreflightSchema>;
export type NativeCheckResult = z.infer<typeof NativeCheckResultSchema>;
export type ProjectCheckReport = z.infer<typeof ProjectCheckReportSchema>;
export const parseProjectCheckReport = (value: unknown): ProjectCheckReport => ProjectCheckReportSchema.parse(value);
