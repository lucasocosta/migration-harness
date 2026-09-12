import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonical } from './normalization.js';
import { MigrationIdSchema, MigrationPathSchema, Sha256Schema } from './migration-config.js';

const label = z.string().trim().min(1).max(4096);
const time = z.string().datetime({ offset: true });
/** Per-file cap for reference inputs; larger evaluation inputs must be refused, not silently truncated. */
export const MAX_REFERENCE_INPUT_BYTES = 8 * 1024 * 1024;

/**
 * Best-effort working-tree revision. `UNVERSIONED` is the honest answer whenever a revision cannot be
 * resolved: a reference fixes working-tree bytes through fingerprints, and a revision is only metadata.
 */
export const RevisionSchema = z.union([z.string().regex(/^[a-f0-9]{40}$/), z.literal('UNVERSIONED')]);
export const FileFingerprintSchema = z.object({
  path: MigrationPathSchema, sha256: Sha256Schema, bytes: z.number().int().nonnegative().max(MAX_REFERENCE_INPUT_BYTES),
}).strict();
const fingerprints = (max: number) => z.array(FileFingerprintSchema).max(max);
/** Working-tree fingerprints of declared inputs, tracked or not; paths stay relative to the side root. */
const inventory = z.object({ root: MigrationPathSchema, revision: RevisionSchema, files: fingerprints(20000).min(1) }).strict();

export const ScenarioReferenceSchema = z.object({
  scenarioId: MigrationIdSchema, required: z.boolean(),
  /** Semantic identity: actions, values, preconditions and completion, excluding side-specific routes/locators. */
  semanticHash: Sha256Schema,
  /** Effective per-side entry URL and locators, the only part an integration adaptation may change. */
  bindings: z.object({ source: Sha256Schema, target: Sha256Schema }).strict(),
  fixtures: fingerprints(10000),
}).strict();
const criterion = z.object({ id: MigrationIdSchema, scenarioId: MigrationIdSchema, required: z.boolean(), digest: Sha256Schema }).strict();
export const ReferenceCriteriaSchema = z.object({
  scenarios: z.array(ScenarioReferenceSchema).min(1).max(1000),
  requirements: z.array(criterion).max(10000),
  acceptedDifferences: z.array(criterion.omit({ required: true })).max(1000),
  checks: z.array(z.object({ id: MigrationIdSchema, side: z.enum(['source', 'target']), required: z.boolean(), digest: Sha256Schema }).strict()).min(1).max(1000),
  policyHash: Sha256Schema, environmentHash: Sha256Schema, limitsHash: Sha256Schema,
  criticalContract: z.object({
    path: MigrationPathSchema, sha256: Sha256Schema, bytes: z.number().int().positive().max(MAX_REFERENCE_INPUT_BYTES),
    contractId: label, contractVersion: label,
  }).strict().optional(),
}).strict();

/** Repeated independent source executions. Collection is P3 work, so `NOT_COLLECTED` fails verification closed. */
export const SourceObservationsSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('NOT_COLLECTED'), runs: z.literal(0) }).strict(),
  z.object({ status: z.enum(['STABLE', 'UNSTABLE']), runs: z.number().int().min(2).max(20), executionHashes: z.array(Sha256Schema).min(2).max(20) }).strict(),
]);

export const WEAKENING_DELTA_KINDS = ['SCENARIO_REMOVED', 'SCENARIO_DEMOTED', 'SCENARIO_SEMANTICS_CHANGED',
  'REQUIREMENT_REMOVED', 'REQUIREMENT_DEMOTED', 'REQUIREMENT_CHANGED', 'CHECK_REMOVED', 'CHECK_DEMOTED', 'CHECK_CHANGED',
  'ACCEPTED_DIFFERENCE_ADDED', 'ACCEPTED_DIFFERENCE_CHANGED', 'FIXTURE_CHANGED', 'FIXTURE_REMOVED', 'POLICY_CHANGED',
  'ENVIRONMENT_CHANGED', 'LIMITS_CHANGED', 'CRITICAL_CONTRACT_CHANGED', 'CRITICAL_CONTRACT_REMOVED',
  'PROTECTED_INPUT_CHANGED', 'SOURCE_INPUT_REMOVED', 'ROOT_CHANGED'] as const;
export const EXTENSION_DELTA_KINDS = ['SCENARIO_ADDED', 'SCENARIO_PROMOTED', 'REQUIREMENT_ADDED', 'REQUIREMENT_PROMOTED',
  'CHECK_ADDED', 'CHECK_PROMOTED', 'ACCEPTED_DIFFERENCE_REMOVED', 'CRITICAL_CONTRACT_ADDED', 'FIXTURE_ADDED',
  'SOURCE_INPUT_ADDED'] as const;
export const BINDING_DELTA_KINDS = ['BINDING_ADAPTED'] as const;
export const INPUT_DELTA_KINDS = ['SOURCE_INPUT_CHANGED', 'SOURCE_REVISION_CHANGED', 'TARGET_INVENTORY_CHANGED',
  'TARGET_REVISION_CHANGED', 'SOURCE_OBSERVATIONS_CHANGED'] as const;
export const ReferenceDeltaSchema = z.object({
  kind: z.enum([...WEAKENING_DELTA_KINDS, ...EXTENSION_DELTA_KINDS, ...BINDING_DELTA_KINDS, ...INPUT_DELTA_KINDS]),
  scenarioId: MigrationIdSchema.optional(), requirementId: MigrationIdSchema.optional(),
  checkId: MigrationIdSchema.optional(), differenceId: MigrationIdSchema.optional(), path: MigrationPathSchema.optional(),
}).strict();
export type ReferenceDelta = z.infer<typeof ReferenceDeltaSchema>;
export type ReferenceDeltaKind = ReferenceDelta['kind'];

const includes = (kinds: readonly string[], kind: string): boolean => kinds.includes(kind);
/** Most severe recorded delta wins: any weakening dominates additions, adaptations and input updates. */
export function referenceChangeClassification(kinds: readonly ReferenceDeltaKind[]): ReferenceChange['classification'] {
  if (!kinds.length) return 'INITIAL';
  if (kinds.some(kind => includes(WEAKENING_DELTA_KINDS, kind))) return 'WEAKENING';
  if (kinds.some(kind => includes(EXTENSION_DELTA_KINDS, kind))) return 'EXTENSION';
  if (kinds.some(kind => includes(BINDING_DELTA_KINDS, kind))) return 'BINDING_ADAPTATION';
  return 'INPUT_UPDATE';
}
export const ReferenceChangeSchema = z.object({
  classification: z.enum(['INITIAL', 'INPUT_UPDATE', 'BINDING_ADAPTATION', 'EXTENSION', 'WEAKENING']),
  deltas: z.array(ReferenceDeltaSchema).max(20000),
  /** Owner decision reference, required exactly when the new version weakens evaluation criteria. */
  ownerDecisionReference: label.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.classification !== referenceChangeClassification(value.deltas.map(item => item.kind))) {
    ctx.addIssue({ code: 'custom', message: 'Classification must match the most severe recorded delta' });
  }
});
export type ReferenceChange = { classification: 'INITIAL' | 'INPUT_UPDATE' | 'BINDING_ADAPTATION' | 'EXTENSION' | 'WEAKENING';
  deltas: ReferenceDelta[]; ownerDecisionReference?: string };

export const ReferenceContentSchema = z.object({
  source: inventory,
  /** `protectedFiles` fingerprints unrelated destination work that must survive the migration. */
  target: inventory.extend({ protectedFiles: fingerprints(20000) }),
  criteria: ReferenceCriteriaSchema,
  sourceObservations: SourceObservationsSchema,
}).strict();
export type ReferenceContent = z.infer<typeof ReferenceContentSchema>;

export const MigrationReferenceSchema = ReferenceContentSchema.extend({
  kind: z.literal('MIGRATION_REFERENCE'), version: z.literal('1'), migrationId: MigrationIdSchema,
  referenceVersion: z.number().int().min(1).max(10000), createdAt: time, configurationHash: Sha256Schema,
  supersedes: z.object({ referenceVersion: z.number().int().min(1).max(10000), referenceHash: Sha256Schema }).strict().optional(),
  change: ReferenceChangeSchema,
}).strict().superRefine((value, ctx) => {
  const issue = (message: string): void => ctx.addIssue({ code: 'custom', message });
  const unique = (items: string[]): boolean => new Set(items).size === items.length;
  const initial = value.change.classification === 'INITIAL';
  if (initial !== (value.referenceVersion === 1) || initial !== !value.supersedes) issue('Version 1 is the initial reference and later versions must supersede one');
  if (value.supersedes && value.supersedes.referenceVersion >= value.referenceVersion) issue('A reference version must supersede an older one');
  if ((value.change.classification === 'WEAKENING') !== (value.change.ownerDecisionReference !== undefined)) issue('Weakened criteria require an owner decision and only they record one');
  for (const files of [value.source.files, value.target.files, value.target.protectedFiles]) if (!unique(files.map(item => item.path))) issue('Duplicate inventory path');
  if (value.source.root === value.target.root) issue('Source and target roots must differ');
  const scenarioIds = value.criteria.scenarios.map(item => item.scenarioId);
  if (!unique(scenarioIds)) issue('Duplicate scenario reference');
  if (!value.criteria.scenarios.some(item => item.required)) issue('At least one required scenario is necessary');
  if (!value.criteria.checks.some(item => item.required && item.side === 'target')) issue('At least one required target check is necessary');
  for (const items of [value.criteria.requirements, value.criteria.acceptedDifferences, value.criteria.checks]) if (!unique(items.map(item => item.id))) issue('Duplicate criterion id');
  for (const item of [...value.criteria.requirements, ...value.criteria.acceptedDifferences]) if (!scenarioIds.includes(item.scenarioId)) issue('Criterion references an unknown scenario');
  for (const scenario of value.criteria.scenarios) if (!unique(scenario.fixtures.map(item => item.path))) issue('Duplicate fixture path');
  if (value.sourceObservations.status !== 'NOT_COLLECTED' && value.sourceObservations.executionHashes.length !== value.sourceObservations.runs) issue('Observation count must match its execution hashes');
});
export type MigrationReference = z.infer<typeof MigrationReferenceSchema>;
export const parseMigrationReference = (value: unknown): MigrationReference => MigrationReferenceSchema.parse(value);
export function migrationReferenceHash(value: unknown): string {
  return createHash('sha256').update(canonical(parseMigrationReference(value))).digest('hex');
}

/** Public-safe verification outcome: codes, counts and hashes only, never evaluation-input contents. */
export const ReferenceFindingSchema = z.object({
  code: z.enum(['CONFIGURATION_MISMATCH', 'SOURCE_INPUT_CHANGED', 'TARGET_INPUT_CHANGED', 'INPUT_MISSING',
    'UNREADABLE_INPUT', 'FIXTURE_CHANGED', 'FIXTURE_ADDED', 'PROTECTED_INPUT_CHANGED', 'PROTECTED_INPUT_ADDED',
    'CRITICAL_CONTRACT_MISMATCH', 'CRITICAL_CONTRACT_UNREADABLE', 'CRITICAL_CONTRACT_NOT_APPROVED',
    'SOURCE_OBSERVATIONS_MISSING', 'SOURCE_OBSERVATIONS_UNSTABLE']),
  severity: z.enum(['BLOCKING', 'INFORMATIONAL']),
  scenarioId: MigrationIdSchema.optional(), path: MigrationPathSchema.optional(),
}).strict();
export const ReferenceVerificationSchema = z.object({
  kind: z.literal('REFERENCE_VERIFICATION'), version: z.literal('1'), migrationId: MigrationIdSchema,
  referenceVersion: z.number().int().min(1).max(10000), referenceHash: Sha256Schema, configurationHash: Sha256Schema,
  verifiedAt: time,
  /** VERIFIED: inputs still match. STALE: evaluation inputs moved. UNVERIFIABLE: cannot be evaluated at all. */
  status: z.enum(['VERIFIED', 'STALE', 'UNVERIFIABLE']),
  criticalContract: z.enum(['ABSENT', 'VERIFIED', 'MISMATCH', 'UNREADABLE', 'NOT_APPROVED']),
  criticalContractSha256: Sha256Schema.optional(),
  findings: z.array(ReferenceFindingSchema).max(20000),
}).strict().superRefine((value, ctx) => {
  const issue = (): void => ctx.addIssue({ code: 'custom', message: 'Verification status contradicts its findings' });
  if ((value.status === 'VERIFIED') !== !value.findings.some(item => item.severity === 'BLOCKING')) issue();
  if (value.status === 'VERIFIED' && !['ABSENT', 'VERIFIED'].includes(value.criticalContract)) issue();
  // An observed digest exists exactly when the configured contract file was readable.
  if (['ABSENT', 'UNREADABLE'].includes(value.criticalContract) !== (value.criticalContractSha256 === undefined)) issue();
});
export type ReferenceFinding = z.infer<typeof ReferenceFindingSchema>;
export type ReferenceVerification = z.infer<typeof ReferenceVerificationSchema>;
export const parseReferenceVerification = (value: unknown): ReferenceVerification => ReferenceVerificationSchema.parse(value);

/** Pick the comparable part of a reference (or a freshly collected candidate content). */
export function referenceContent(value: unknown): ReferenceContent {
  const object = (value ?? {}) as Record<string, unknown>;
  return ReferenceContentSchema.parse({
    source: object.source, target: object.target, criteria: object.criteria, sourceObservations: object.sourceObservations,
  });
}

/**
 * Compare two reference contents and classify the change. Pure: it decides which deltas exist, never whether
 * they are acceptable. Weakening a criterion stays a WEAKENING here so the caller must escalate it.
 */
export function classifyReferenceChange(previous: unknown, next: unknown): ReferenceChange {
  const before = referenceContent(previous), after = referenceContent(next);
  const deltas: ReferenceDelta[] = [];
  const push = (kind: ReferenceDeltaKind, extra: Omit<ReferenceDelta, 'kind'> = {}): void => { deltas.push({ kind, ...extra }); };
  const byPath = (files: readonly z.infer<typeof FileFingerprintSchema>[]): Map<string, string> => new Map(files.map(item => [item.path, item.sha256]));
  if (before.source.root !== after.source.root || before.target.root !== after.target.root) push('ROOT_CHANGED');
  if (before.source.revision !== after.source.revision) push('SOURCE_REVISION_CHANGED');
  if (before.target.revision !== after.target.revision) push('TARGET_REVISION_CHANGED');
  const beforeSource = byPath(before.source.files), afterSource = byPath(after.source.files);
  for (const [path, sha256] of afterSource) {
    if (!beforeSource.has(path)) push('SOURCE_INPUT_ADDED', { path });
    else if (beforeSource.get(path) !== sha256) push('SOURCE_INPUT_CHANGED', { path });
  }
  for (const path of beforeSource.keys()) if (!afterSource.has(path)) push('SOURCE_INPUT_REMOVED', { path });
  // The candidate is expected to change; one aggregate delta records it without implying a defect.
  if (canonical(before.target.files) !== canonical(after.target.files)) push('TARGET_INVENTORY_CHANGED');
  const afterProtected = byPath(after.target.protectedFiles);
  for (const [path, sha256] of byPath(before.target.protectedFiles)) if (afterProtected.get(path) !== sha256) push('PROTECTED_INPUT_CHANGED', { path });
  const beforeScenarios = new Map(before.criteria.scenarios.map(item => [item.scenarioId, item]));
  const afterScenarios = new Map(after.criteria.scenarios.map(item => [item.scenarioId, item]));
  for (const [scenarioId, scenario] of afterScenarios) {
    const previousScenario = beforeScenarios.get(scenarioId);
    if (!previousScenario) { push('SCENARIO_ADDED', { scenarioId }); continue; }
    if (previousScenario.semanticHash !== scenario.semanticHash) push('SCENARIO_SEMANTICS_CHANGED', { scenarioId });
    if (canonical(previousScenario.bindings) !== canonical(scenario.bindings)) push('BINDING_ADAPTED', { scenarioId });
    if (previousScenario.required !== scenario.required) push(scenario.required ? 'SCENARIO_PROMOTED' : 'SCENARIO_DEMOTED', { scenarioId });
    const previousFixtures = byPath(previousScenario.fixtures), currentFixtures = byPath(scenario.fixtures);
    for (const [path, sha256] of currentFixtures) {
      if (!previousFixtures.has(path)) push('FIXTURE_ADDED', { scenarioId, path });
      else if (previousFixtures.get(path) !== sha256) push('FIXTURE_CHANGED', { scenarioId, path });
    }
    for (const path of previousFixtures.keys()) if (!currentFixtures.has(path)) push('FIXTURE_REMOVED', { scenarioId, path });
  }
  for (const scenarioId of beforeScenarios.keys()) if (!afterScenarios.has(scenarioId)) push('SCENARIO_REMOVED', { scenarioId });
  const beforeRequirements = new Map(before.criteria.requirements.map(item => [item.id, item]));
  const afterRequirements = new Map(after.criteria.requirements.map(item => [item.id, item]));
  for (const [requirementId, requirement] of afterRequirements) {
    const previousRequirement = beforeRequirements.get(requirementId);
    if (!previousRequirement) { push('REQUIREMENT_ADDED', { requirementId, scenarioId: requirement.scenarioId }); continue; }
    if (previousRequirement.digest !== requirement.digest || previousRequirement.scenarioId !== requirement.scenarioId) push('REQUIREMENT_CHANGED', { requirementId });
    if (previousRequirement.required !== requirement.required) push(requirement.required ? 'REQUIREMENT_PROMOTED' : 'REQUIREMENT_DEMOTED', { requirementId });
  }
  for (const requirementId of beforeRequirements.keys()) if (!afterRequirements.has(requirementId)) push('REQUIREMENT_REMOVED', { requirementId });
  const beforeChecks = new Map(before.criteria.checks.map(item => [item.id, item]));
  const afterChecks = new Map(after.criteria.checks.map(item => [item.id, item]));
  for (const [checkId, check] of afterChecks) {
    const previousCheck = beforeChecks.get(checkId);
    if (!previousCheck) { push('CHECK_ADDED', { checkId }); continue; }
    if (previousCheck.digest !== check.digest || previousCheck.side !== check.side) push('CHECK_CHANGED', { checkId });
    if (previousCheck.required !== check.required) push(check.required ? 'CHECK_PROMOTED' : 'CHECK_DEMOTED', { checkId });
  }
  for (const checkId of beforeChecks.keys()) if (!afterChecks.has(checkId)) push('CHECK_REMOVED', { checkId });
  const beforeDifferences = new Map(before.criteria.acceptedDifferences.map(item => [item.id, item]));
  const afterDifferences = new Map(after.criteria.acceptedDifferences.map(item => [item.id, item]));
  for (const [differenceId, difference] of afterDifferences) {
    const previousDifference = beforeDifferences.get(differenceId);
    if (!previousDifference) push('ACCEPTED_DIFFERENCE_ADDED', { differenceId, scenarioId: difference.scenarioId });
    else if (previousDifference.digest !== difference.digest || previousDifference.scenarioId !== difference.scenarioId) push('ACCEPTED_DIFFERENCE_CHANGED', { differenceId });
  }
  for (const differenceId of beforeDifferences.keys()) if (!afterDifferences.has(differenceId)) push('ACCEPTED_DIFFERENCE_REMOVED', { differenceId });
  if (before.criteria.policyHash !== after.criteria.policyHash) push('POLICY_CHANGED');
  if (before.criteria.environmentHash !== after.criteria.environmentHash) push('ENVIRONMENT_CHANGED');
  if (before.criteria.limitsHash !== after.criteria.limitsHash) push('LIMITS_CHANGED');
  const beforeContract = before.criteria.criticalContract, afterContract = after.criteria.criticalContract;
  if (!beforeContract && afterContract) push('CRITICAL_CONTRACT_ADDED');
  else if (beforeContract && !afterContract) push('CRITICAL_CONTRACT_REMOVED');
  else if (beforeContract && afterContract && canonical(beforeContract) !== canonical(afterContract)) push('CRITICAL_CONTRACT_CHANGED');
  if (canonical(before.sourceObservations) !== canonical(after.sourceObservations)) push('SOURCE_OBSERVATIONS_CHANGED');
  return { classification: referenceChangeClassification(deltas.map(item => item.kind)), deltas };
}
