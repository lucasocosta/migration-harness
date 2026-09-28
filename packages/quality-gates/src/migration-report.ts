import {
  canonical, migrationConfigHash, parseMigrationConfig, parseEquivalenceResult,
  MigrationReportInputSchema, MigrationReportSchema, ScenarioVerificationSchema,
  UnitAssertionOutcomeSchema, VerificationIdentitySchema,
  type MigrationDiagnostic, type MigrationReport, type ScenarioVerification,
  type VerificationStatus,
} from '@migration-harness/core';

function combined(statuses: VerificationStatus[]): VerificationStatus {
  if (!statuses.length || statuses.includes('INCONCLUSIVE')) return 'INCONCLUSIVE';
  return statuses.includes('FAIL') ? 'FAIL' : 'PASS';
}

/** Aggregate caller-collected evidence; identity hashes and flags are not provenance authentication. */
export function buildMigrationReport(configuration: unknown, evidence: unknown): MigrationReport {
  const config = parseMigrationConfig(configuration);
  const input = MigrationReportInputSchema.parse(evidence);
  const diagnostics: MigrationDiagnostic[] = [...input.executionDiagnostics ?? []];
  let invalid = false;
  const invalidate = (code: MigrationDiagnostic['code']): void => { diagnostics.push({ code }); invalid = true; };
  if (input.identity.configurationHash !== migrationConfigHash(config) || input.identity.migrationId !== config.migrationId) invalidate('CONFIGURATION_MISMATCH');
  if (!input.referenceVerified) invalidate('REFERENCE_UNVERIFIED');
  const reference = input.reference;
  if (reference) {
    if (reference.migrationId !== config.migrationId || reference.configurationHash !== migrationConfigHash(config)) invalidate('CONFIGURATION_MISMATCH');
    // The evidence must be bound to the very reference that was verified.
    if (reference.referenceHash !== input.identity.referenceHash) invalidate('REFERENCE_MISMATCH');
    if (reference.status !== 'VERIFIED') invalidate('REFERENCE_UNVERIFIED');
  }
  // A configured critical contract only counts when a verified reference confirmed the approved bytes.
  if (config.criticalContract && !(reference && reference.status === 'VERIFIED' && reference.criticalContract === 'VERIFIED'
    && reference.criticalContractSha256 === config.criticalContract.sha256)) invalidate('CRITICAL_CONTRACT_UNVERIFIED');
  const currentIdentity = canonical(input.identity);
  const scenarios = input.scenarios.filter(result => {
    if (canonical(result.identity) !== currentIdentity) { invalidate('STALE_EVIDENCE'); return false; }
    if (!config.scenarios.some(item => item.definition.scenarioId === result.scenarioId)) { invalidate('UNKNOWN_EVIDENCE'); return false; }
    return true;
  });
  const checks = input.checks.filter(result => {
    if (canonical(result.identity) !== currentIdentity) { invalidate('STALE_EVIDENCE'); return false; }
    if (!config.checks.some(item => item.id === result.checkId)) { invalidate('UNKNOWN_EVIDENCE'); return false; }
    return true;
  });
  if (new Set(scenarios.map(item => item.scenarioId)).size !== scenarios.length
    || new Set(checks.map(item => item.checkId)).size !== checks.length) invalidate('DUPLICATE_EVIDENCE');
  for (const result of scenarios) {
    if (new Set(result.requirements.map(item => item.requirementId)).size !== result.requirements.length) invalidate('DUPLICATE_EVIDENCE');
    if (result.requirements.some(item => !config.requirements.some(expected => expected.id === item.requirementId && expected.scenarioId === result.scenarioId))) invalidate('UNKNOWN_EVIDENCE');
  }

  const requiredScenarios = config.scenarios.filter(item => item.required);
  const requiredRequirements = config.requirements.filter(item => item.required);
  const requiredChecks = config.checks.filter(item => item.required);
  const preservationStates = requiredScenarios.map(item => {
    const result = scenarios.find(result => result.scenarioId === item.definition.scenarioId);
    if (!result) diagnostics.push({ code: 'MISSING_SCENARIO', scenarioId: item.definition.scenarioId });
    return result?.status ?? 'INCONCLUSIVE';
  });
  const requirementStates = requiredRequirements.map(item => {
    const result = scenarios.find(result => result.scenarioId === item.scenarioId)?.requirements.find(result => result.requirementId === item.id);
    if (!result) diagnostics.push({ code: 'MISSING_REQUIREMENT', scenarioId: item.scenarioId, requirementId: item.id });
    return result?.status ?? 'INCONCLUSIVE';
  });
  const checkStates = requiredChecks.map(item => {
    const result = checks.find(result => result.checkId === item.id);
    if (!result) diagnostics.push({ code: 'MISSING_CHECK', checkId: item.id });
    return result?.status ?? 'INCONCLUSIVE';
  });
  diagnostics.push(...scenarios.flatMap(item => item.diagnostics), ...checks.flatMap(item => item.diagnostics));
  const preservation = combined(preservationStates);
  const requirements = requiredRequirements.length ? combined(requirementStates) : 'NOT_APPLICABLE';
  const projectChecks = combined(checkStates);
  const status = invalid ? 'INCONCLUSIVE' : combined([preservation, projectChecks, ...(requirements === 'NOT_APPLICABLE' ? [] : [requirements]),
    ...(input.criticalContractStatus ? [input.criticalContractStatus] : [])]);
  // Never claim STRICT isolation when the process opted into insecure storage.
  const degradedEnv = process.env.MIGRATION_HARNESS_ALLOW_INSECURE_PRIVATE_STORE === '1';
  let privacy = input.privacy ?? { mode: (degradedEnv ? 'DEGRADED_INSECURE' : 'STRICT') as 'STRICT' | 'DEGRADED_INSECURE', platform: process.platform };
  if (degradedEnv && privacy.mode === 'STRICT') {
    privacy = { mode: 'DEGRADED_INSECURE', platform: privacy.platform, detailCode: 'ENV_ALLOW_INSECURE_PRIVATE_STORE' };
  }
  if (privacy.mode === 'DEGRADED_INSECURE') {
    if (!diagnostics.some(item => item.code === 'WEAK_PRIVATE_PERMISSIONS')) diagnostics.push({ code: 'WEAK_PRIVATE_PERMISSIONS', detailCode: privacy.detailCode });
    if (!diagnostics.some(item => item.code === 'DEGRADED_ISOLATION')) diagnostics.push({ code: 'DEGRADED_ISOLATION', detailCode: privacy.detailCode });
  }
  return MigrationReportSchema.parse({
    kind: 'MIGRATION_REPORT', version: '1', identity: input.identity, evaluatedAt: input.evaluatedAt,
    status, preservation, requirements, projectChecks, referenceStatus: reference?.status ?? 'DECLARED',
    requiredCoverage: {
      scenarios: { expected: requiredScenarios.length, received: requiredScenarios.filter(item => scenarios.some(result => result.scenarioId === item.definition.scenarioId)).length },
      requirements: { expected: requiredRequirements.length, received: requiredRequirements.filter(item => scenarios.some(result => result.scenarioId === item.scenarioId && result.requirements.some(result => result.requirementId === item.id))).length },
      checks: { expected: requiredChecks.length, received: requiredChecks.filter(item => checks.some(result => result.checkId === item.id)).length },
    },
    diagnostics, scenarios, checks, privacy, ...(input.criticalContractStatus ? { criticalContractStatus: input.criticalContractStatus } : {}),
  });
}

/** v0.2 shape equivalence is useful evidence, not proof of the standard value/outcome criteria. */
export function adaptLegacyComparison(value: unknown, identity: unknown): ScenarioVerification {
  const result = parseEquivalenceResult(value);
  const parsedIdentity = VerificationIdentitySchema.parse(identity);
  if (result.divergences.some(item => item.scenarioId !== result.scenarioId)) throw new Error('Legacy divergence scenario mismatch');
  const blocking = result.divergences.filter(item => item.severity === 'BLOCKING');
  const incomplete = blocking.some(item => ['SCENARIO_FAILED', 'INSUFFICIENT_EVIDENCE', 'NETWORK_INCOMPLETE_EXCHANGE', 'NON_DETERMINISTIC_EXECUTION', 'CAUSAL_ALIGNMENT_BUDGET_EXCEEDED', 'VALUE_EVIDENCE_OMITTED', 'UNIT_ASSERTION_NOT_EVALUABLE'].includes(item.code) || item.dimension === 'SECURITY');
  const preservationFailed = blocking.some(item => item.dimension !== 'CONTRACT' && item.dimension !== 'SECURITY');
  return ScenarioVerificationSchema.parse({
    identity: parsedIdentity, scenarioId: result.scenarioId,
    status: incomplete || !preservationFailed ? 'INCONCLUSIVE' : 'FAIL',
    requirements: [], evidencePaths: [],
    diagnostics: [
      { code: 'LEGACY_LIMITED_EVIDENCE', scenarioId: result.scenarioId },
      ...(blocking.length ? [{ code: 'LEGACY_DIVERGENCE', scenarioId: result.scenarioId }] : []),
      ...(incomplete ? [{ code: 'EXECUTION_INCOMPLETE', scenarioId: result.scenarioId }] : []),
      // Mocked coverage is a declared limitation of the evidence, carried into the report as such.
      ...(result.divergences.some(item => item.code === 'MOCKED_COVERAGE') ? [{ code: 'MOCKED_COVERAGE', scenarioId: result.scenarioId }] : []),
      ...(result.divergences.some(item => item.severity !== 'BLOCKING' && item.code !== 'MOCKED_COVERAGE') ? [{ code: 'LEGACY_WARNING', scenarioId: result.scenarioId }] : []),
    ],
  });
}


/**
 * Map target-side unit assertion outcomes to requirement statuses for a scenario verification. A violated
 * assertion is a failed requirement; one that could not be evaluated is inconclusive, never a pass.
 */
export function assertionRequirementStatuses(outcomes: unknown): Array<{ requirementId: string; status: VerificationStatus }> {
  const parsed = UnitAssertionOutcomeSchema.array().max(10000).parse(outcomes).filter(item => item.side === 'target');
  if (new Set(parsed.map(item => item.assertionId)).size !== parsed.length) throw new Error('Duplicate target assertion outcome');
  return parsed.map(item => ({
    requirementId: item.assertionId,
    status: item.status === 'SATISFIED' ? 'PASS' : item.status === 'VIOLATED' ? 'FAIL' : 'INCONCLUSIVE',
  }));
}
