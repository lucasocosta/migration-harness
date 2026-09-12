import { z } from 'zod';
import { canonical } from './normalization.js';
import { MigrationIdSchema, MigrationPathSchema, Sha256Schema } from './migration-config.js';
import { ReferenceVerificationSchema } from './migration-reference.js';

export const VerificationStatusSchema = z.enum(['PASS', 'FAIL', 'INCONCLUSIVE']);
export const VerificationIdentitySchema = z.object({
  migrationId: MigrationIdSchema, configurationHash: Sha256Schema, referenceHash: Sha256Schema,
  candidateHash: Sha256Schema, buildHash: Sha256Schema,
}).strict();
export const MigrationDiagnosticSchema = z.object({
  code: z.enum(['MISSING_SCENARIO', 'MISSING_REQUIREMENT', 'MISSING_CHECK', 'STALE_EVIDENCE',
    'DUPLICATE_EVIDENCE', 'UNKNOWN_EVIDENCE', 'REFERENCE_UNVERIFIED', 'REFERENCE_MISMATCH', 'CONFIGURATION_MISMATCH',
    'LEGACY_DIVERGENCE', 'LEGACY_WARNING', 'LEGACY_LIMITED_EVIDENCE', 'EXECUTION_INCOMPLETE', 'MOCKED_COVERAGE', 'CRITICAL_CONTRACT_UNVERIFIED',
    'BEHAVIOR_DIVERGENCE', 'STANDARD_WARNING', 'EXPECTED_DIFFERENCE', 'REQUIREMENT_VIOLATED', 'REQUIREMENT_NOT_EVALUABLE',
    'NATIVE_CHECK_FAILED', 'NATIVE_CHECK_INCONCLUSIVE', 'BASELINE_RESOLVED', 'SOURCE_UNSTABLE', 'OPERATION_FAILED', 'CRITICAL_CONTRACT_VIOLATED']),
  scenarioId: MigrationIdSchema.optional(), requirementId: MigrationIdSchema.optional(), checkId: MigrationIdSchema.optional(),
  side: z.enum(['source', 'target']).optional(), stepId: MigrationIdSchema.optional(),
  category: z.enum(['IMPLEMENTATION', 'OPERATIONAL', 'EVIDENCE', 'BASELINE']).optional(),
  detailCode: z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(160).optional(),
}).strict();
const result = z.object({
  status: VerificationStatusSchema,
  diagnostics: z.array(MigrationDiagnosticSchema).max(10000),
  evidencePaths: z.array(MigrationPathSchema).max(1000),
}).strict();
// Disclosures may accompany a pass; anything else contradicts it.
const consistentResult = (value: z.infer<typeof result>): boolean => value.status !== 'PASS'
  || value.diagnostics.every(item => ['LEGACY_WARNING', 'MOCKED_COVERAGE', 'STANDARD_WARNING', 'BASELINE_RESOLVED', 'EXPECTED_DIFFERENCE'].includes(item.code));
export const ScenarioVerificationSchema = result.extend({
  identity: VerificationIdentitySchema,
  scenarioId: MigrationIdSchema,
  requirements: z.array(z.object({ requirementId: MigrationIdSchema, status: VerificationStatusSchema }).strict()).max(10000),
}).refine(consistentResult, 'PASS contradicts diagnostic evidence');
export const ProjectCheckVerificationSchema = result.extend({ identity: VerificationIdentitySchema, checkId: MigrationIdSchema })
  .refine(consistentResult, 'PASS contradicts diagnostic evidence');
export const MigrationReportInputSchema = z.object({
  identity: VerificationIdentitySchema,
  evaluatedAt: z.string().datetime({ offset: true }),
  /** Collector declaration. A harness-issued reference verification is the stronger evidence below. */
  referenceVerified: z.boolean(),
  /** Outcome of verifying the versioned reference against the workspace; required for a verified contract. */
  reference: ReferenceVerificationSchema.optional(),
  scenarios: z.array(ScenarioVerificationSchema).max(10000),
  checks: z.array(ProjectCheckVerificationSchema).max(10000),
  criticalContractStatus: VerificationStatusSchema.optional(),
  executionDiagnostics: z.array(MigrationDiagnosticSchema).max(10000).optional(),
}).strict();
export const MigrationReportSchema = z.object({
  kind: z.literal('MIGRATION_REPORT'), version: z.literal('1'),
  identity: VerificationIdentitySchema, evaluatedAt: z.string().datetime({ offset: true }),
  status: VerificationStatusSchema,
  preservation: VerificationStatusSchema,
  requirements: z.enum(['PASS', 'FAIL', 'INCONCLUSIVE', 'NOT_APPLICABLE']),
  projectChecks: VerificationStatusSchema,
  /** DECLARED means no reference verification was supplied: weaker evidence, never silently upgraded. */
  referenceStatus: z.enum(['DECLARED', 'VERIFIED', 'STALE', 'UNVERIFIABLE']),
  requiredCoverage: z.object({
    scenarios: z.object({ expected: z.number().int().nonnegative(), received: z.number().int().nonnegative() }).strict(),
    requirements: z.object({ expected: z.number().int().nonnegative(), received: z.number().int().nonnegative() }).strict(),
    checks: z.object({ expected: z.number().int().nonnegative(), received: z.number().int().nonnegative() }).strict(),
  }).strict(),
  diagnostics: z.array(MigrationDiagnosticSchema).max(10000),
  scenarios: z.array(ScenarioVerificationSchema).max(10000),
  checks: z.array(ProjectCheckVerificationSchema).max(10000),
  criticalContractStatus: VerificationStatusSchema.optional(),
}).strict().superRefine((value, ctx) => {
  const issue = (): void => ctx.addIssue({ code: 'custom', message: 'Report status contradicts required evidence' });
  if ([...value.scenarios, ...value.checks].some(item => canonical(item.identity) !== canonical(value.identity))) issue();
  for (const coverage of Object.values(value.requiredCoverage)) if (coverage.received > coverage.expected) issue();
  if (value.status === 'FAIL' && ![value.preservation, value.requirements, value.projectChecks, value.criticalContractStatus].includes('FAIL')) issue();
  if (value.status === 'PASS' && value.criticalContractStatus && value.criticalContractStatus !== 'PASS') issue();
  if (value.status === 'PASS' && (value.preservation !== 'PASS' || value.projectChecks !== 'PASS'
    || !['PASS', 'NOT_APPLICABLE'].includes(value.requirements)
    || !value.requiredCoverage.scenarios.expected || !value.requiredCoverage.checks.expected
    || Object.values(value.requiredCoverage).some(item => item.received !== item.expected))) issue();
  if (value.status === 'PASS' && !['DECLARED', 'VERIFIED'].includes(value.referenceStatus)) issue();
  if (value.status === 'PASS' && value.diagnostics.some(item => ['REFERENCE_UNVERIFIED', 'REFERENCE_MISMATCH', 'CONFIGURATION_MISMATCH',
    'STALE_EVIDENCE', 'DUPLICATE_EVIDENCE', 'UNKNOWN_EVIDENCE', 'CRITICAL_CONTRACT_UNVERIFIED'].includes(item.code))) issue();
});

export type VerificationIdentity = z.infer<typeof VerificationIdentitySchema>;
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;
export type MigrationDiagnostic = z.infer<typeof MigrationDiagnosticSchema>;
export type ScenarioVerification = z.infer<typeof ScenarioVerificationSchema>;
export type MigrationReportInput = z.infer<typeof MigrationReportInputSchema>;
export type MigrationReport = z.infer<typeof MigrationReportSchema>;
export const parseMigrationReport = (value: unknown): MigrationReport => MigrationReportSchema.parse(value);
