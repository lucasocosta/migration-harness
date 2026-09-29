import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonical } from './normalization.js';
import { HarnessPolicySchema, ScenarioDefinitionSchema } from './schemas.js';
import { ResponseFieldClaimSchema, UnitAssertionBodySchema, UnitScopeSchema, type ResponseFieldRequirement, type UnitAssertion, type UnitScope } from './unit-assertion.js';

export const MigrationIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const label = z.string().trim().min(1).max(4096);
// Lexical validation only; filesystem ownership and symlink checks belong to execution.
export const MigrationPathSchema = z.string().min(1).max(4096).refine(value => {
  const parts = value.split('/');
  return !/[\\\x00-\x1f:*?]/.test(value) && parts.every(part => part !== '' && part !== '.' && part !== '..'
    && !['.migration-private', '.git'].includes(part) && !/^\.env(?:\.|$)/.test(part));
}, 'Expected a normalized public workspace-relative path');
const cwd = z.union([z.literal('.'), MigrationPathSchema]);
const httpUrl = z.string().url().refine(value => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}, 'Expected an HTTP(S) test URL without credentials');

export const ProjectCommandSchema = z.object({
  id: MigrationIdSchema,
  kind: z.enum(['build', 'typecheck', 'lint', 'test', 'serve', 'reset']),
  argv: z.array(z.string().min(1).max(4096).refine(value => !value.includes('\0'))).min(1).max(128),
  cwd,
  timeoutMs: z.number().int().positive().max(3_600_000),
}).strict();
const project = z.object({
  root: MigrationPathSchema,
  baseUrl: httpUrl,
  relevantFiles: z.array(MigrationPathSchema).min(1).max(10000),
  commands: z.array(ProjectCommandSchema).max(100),
  generatedPaths: z.array(MigrationPathSchema).max(30).optional(),
  /** Explicit consent to clean an exclusively generated output directory before managed builds. */
  build: z.object({ commandId: MigrationIdSchema, outputDir: MigrationPathSchema, cleanOutput: z.literal(true) }).strict().optional(),
  /**
   * Managed self-serving application (PHP built-in server, Java JAR, SSR runtime): the harness spawns this
   * command with the side root as cwd, gates capture on readiness at baseUrl and tears down the whole
   * process tree. Absent, the harness serves build.outputDir statically instead.
   */
  serve: z.object({ commandId: MigrationIdSchema, readyTimeoutMs: z.number().int().positive().max(3_600_000).optional() }).strict().optional(),
}).strict();
const binding = z.object({
  entryUrl: httpUrl,
  steps: z.array(z.object({ stepId: MigrationIdSchema, targetRole: label, targetName: label.optional(), targetLabel: label.optional() }).strict()).max(1000),
  /** How this application identifies the migrated unit's container; the shell around it is out of scope. */
  unitScope: UnitScopeSchema.optional(),
}).strict();
const scenario = z.object({
  definition: ScenarioDefinitionSchema,
  required: z.boolean(),
  fixtureRoot: MigrationPathSchema,
  bindings: z.object({ source: binding, target: binding }).strict(),
}).strict();
const check = z.object({
  id: MigrationIdSchema, side: z.enum(['source', 'target']), commandId: MigrationIdSchema, required: z.boolean(),
}).strict();
const requirement = z.object({
  id: MigrationIdSchema, scenarioId: MigrationIdSchema, description: label,
  origin: z.enum(['SPECIFICATION', 'EXISTING_TEST', 'CRITICAL_CONTRACT']), sourceReference: label,
  required: z.boolean(),
  /** Optional machine-checkable claim; without it the requirement needs caller-supplied evidence. */
  assertion: UnitAssertionBodySchema.optional(),
  /**
   * Optional API-surface claim over the scenario's recorded HTTP exchanges. It is deliberately not part of
   * `assertion`: the differential assertion pass never evaluates it, quality-gates does, so an unevaluable
   * response field stays INCONCLUSIVE instead of being judged by a pass it does not belong to.
   */
  responseClaim: ResponseFieldClaimSchema.optional(),
}).strict();

export const MigrationConfigSchema = z.object({
  kind: z.literal('MIGRATION_CONFIG'), version: z.literal('1'), migrationId: MigrationIdSchema,
  profile: z.literal('standard').optional(),
  source: project,
  target: project.extend({ writePaths: z.array(MigrationPathSchema).min(1).max(1000), protectedPaths: z.array(MigrationPathSchema).max(1000) }),
  scenarios: z.array(scenario).min(1).max(1000),
  checks: z.array(check).min(1).max(1000),
  requirements: z.array(requirement).max(10000),
  acceptedDifferences: z.array(z.object({
    id: MigrationIdSchema, scenarioId: MigrationIdSchema, description: label, decisionReference: label,
    /** Explicit, bounded exceptions with independently checked source and required target claims. */
    resolution: z.object({
      sourceAssertions: z.array(UnitAssertionBodySchema).min(1).max(100),
      targetRequirementIds: z.array(MigrationIdSchema).min(1).max(100),
      matches: z.array(z.discriminatedUnion('code', [
        z.object({ code: z.literal('NETWORK_PAYLOAD_VALUE_MISMATCH'), requestPath: label,
          field: z.string().regex(/^payload(?:\.[A-Za-z0-9_]+)+$/), count: z.number().int().positive().max(100) }).strict(),
        z.object({ code: z.literal('NETWORK_MISSING_REQUEST'), requestPath: label,
          method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']), count: z.number().int().positive().max(100) }).strict(),
      ])).min(1).max(100),
    }).strict().optional(),
  }).strict()).max(1000),
  criticalContract: z.object({ path: MigrationPathSchema, sha256: Sha256Schema }).strict().optional(),
  policy: HarnessPolicySchema.omit({ assistant: true }),
  reset: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('ISOLATED_FIXTURES') }).strict(),
    z.object({ kind: z.literal('COMMANDS'), sourceCommandId: MigrationIdSchema, targetCommandId: MigrationIdSchema }).strict(),
  ]),
  environment: z.object({
    browser: z.literal('chromium'), locale: label,
    viewport: z.object({ width: z.number().int().positive().max(10000), height: z.number().int().positive().max(10000) }).strict(),
  }).strict(),
  limits: z.object({
    sourceRuns: z.number().int().min(2).max(20), maxRepairAttempts: z.number().int().min(0).max(100),
    maxDurationMs: z.number().int().positive().max(86_400_000),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const issue = (message: string): void => ctx.addIssue({ code: 'custom', message });
  const unique = (items: string[]): boolean => new Set(items).size === items.length;
  const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  if (overlaps(value.source.root, value.target.root)) issue('Source and target roots must not overlap');
  for (const side of ['source', 'target'] as const) {
    if (!unique(value[side].commands.map(item => item.id)) || !unique(value[side].relevantFiles)) issue('Duplicate project command or relevant file');
    const build = value[side].build;
    const protectedInputs = [...value[side].relevantFiles, ...(side === 'target' ? [...value.target.writePaths, ...value.target.protectedPaths] : [])];
    for (const generated of value[side].generatedPaths ?? []) {
      if (['src', 'public', 'node_modules'].includes(generated.split('/')[0]!) || protectedInputs.some(path => overlaps(generated, path))
        || value.scenarios.some(item => overlaps(`${value[side].root}/${generated}`, item.fixtureRoot))
        || value.criticalContract && overlaps(`${value[side].root}/${generated}`, value.criticalContract.path)) issue('Generated paths overlap protected inputs');
    }
    if (build) {
      if (!value[side].commands.some(command => command.id === build.commandId && command.kind === 'build')
        || !value.checks.some(check => check.side === side && check.commandId === build.commandId && check.required)) issue('Managed build must reference a required build check');
      const protectedPaths = [...value[side].relevantFiles, ...(side === 'target' ? [...value.target.writePaths, ...value.target.protectedPaths] : [])];
      if (['src', 'public', 'node_modules'].includes(build.outputDir.split('/')[0]!)
        || protectedPaths.some(path => overlaps(build.outputDir, path))) issue('Build output overlaps project inputs');
    }
  }
  if (!unique(value.target.writePaths) || !unique(value.target.protectedPaths)) issue('Duplicate target scope path');
  if (value.target.writePaths.some(write => value.target.protectedPaths.some(protectedPath => overlaps(write, protectedPath)))) issue('Writable and protected paths overlap');
  const ids = value.scenarios.map(item => item.definition.scenarioId);
  if (!unique(ids) || ids.some(id => !MigrationIdSchema.safeParse(id).success)) issue('Invalid or duplicate scenario id');
  if (!value.scenarios.some(item => item.required)) issue('At least one required scenario is necessary');
  if (!value.checks.some(item => item.required && item.side === 'target')) issue('At least one required target project check is necessary');
  for (const items of [value.checks, value.requirements, value.acceptedDifferences]) if (!unique(items.map(item => item.id))) issue('Duplicate check, requirement or difference id');
  for (const item of value.checks) {
    const command = value[item.side].commands.find(command => command.id === item.commandId);
    if (!command || ['serve', 'reset'].includes(command.kind)) issue('Check must reference a project validation command');
  }
  for (const item of [...value.requirements, ...value.acceptedDifferences]) if (!ids.includes(item.scenarioId)) issue('Criterion references an unknown scenario');
  for (const item of value.acceptedDifferences) if (item.resolution) {
    if (!unique(item.resolution.targetRequirementIds) || item.resolution.targetRequirementIds.some(id =>
      !value.requirements.some(requirement => requirement.id === id && requirement.scenarioId === item.scenarioId && requirement.required && requirement.assertion))) issue('Expected differences require mandatory machine-checkable target requirements in their scenario');
    for (const match of item.resolution.matches) if (!match.requestPath.startsWith('/') || /[\s?#]/.test(match.requestPath)) issue('Expected difference requires an exact normalized request path');
  }
  if (value.requirements.some(item => item.origin === 'CRITICAL_CONTRACT') && !value.criticalContract) issue('Critical-contract requirement needs a contract reference');
  // The standard profile compares values, not only shapes: a configuration cannot opt out of that criterion.
  if (value.policy.network?.comparePayloadValues === false || value.policy.network?.compareResponseValues === false
    || value.policy.network?.comparePayloadShape === false || value.policy.network?.compareStatusCode === false
    || value.policy.network?.compareResponseShape === false) issue('Standard comparison criteria cannot be disabled by configuration');
  if (value.reset.kind === 'COMMANDS') {
    for (const side of ['source', 'target'] as const) if (!value[side].commands.some(command => command.id === (value.reset.kind === 'COMMANDS' ? value.reset[`${side}CommandId`] : '') && command.kind === 'reset')) issue('Reset must reference a reset command on each side');
  }
  for (const item of value.scenarios) {
    for (const mock of item.definition.preconditions.mockInitialApiResponses ?? []) for (const response of [mock, ...(mock.sequence ?? [])]) if (!MigrationPathSchema.safeParse(response.fixturePath).success) issue('Fixture must stay inside its scenario fixture root');
    for (const side of ['source', 'target'] as const) {
      const bound = item.bindings[side];
      if (httpUrl.safeParse(bound.entryUrl).success && httpUrl.safeParse(value[side].baseUrl).success
        && new URL(bound.entryUrl).origin !== new URL(value[side].baseUrl).origin) issue('Binding origin must match its project');
      if (!unique(bound.steps.map(step => step.stepId)) || bound.steps.some(step => !item.definition.steps.some(original => original.stepId === step.stepId))) issue('Binding references a duplicate or unknown step');
      const steps = item.definition.steps.map(step => ({ ...step, ...bound.steps.find(boundStep => boundStep.stepId === step.stepId) }));
      if (!ScenarioDefinitionSchema.safeParse({ ...item.definition, entryUrl: bound.entryUrl, steps }).success) issue('Binding must retain a valid scenario action and role');
    }
  }
});

export type MigrationConfig = z.infer<typeof MigrationConfigSchema>;
export const parseMigrationConfig = (value: unknown): MigrationConfig => MigrationConfigSchema.parse(value);
export function migrationConfigHash(value: unknown): string {
  return createHash('sha256').update(canonical(parseMigrationConfig(value))).digest('hex');
}

/** Machine-checkable requirements of one scenario, carrying their requirement id and enforcement. */
export function unitAssertionsForScenario(config: MigrationConfig, scenarioId: string): UnitAssertion[] {
  return config.requirements.flatMap(item => item.scenarioId === scenarioId && item.assertion
    ? [{ id: item.id, required: item.required, ...item.assertion }] : []);
}

/** Response-field requirements of one scenario; evaluated per side against its recorded HTTP exchanges. */
export function responseFieldClaimsForScenario(config: MigrationConfig, scenarioId: string): ResponseFieldRequirement[] {
  return config.requirements.flatMap(item => item.scenarioId === scenarioId && item.responseClaim
    ? [{ id: item.id, required: item.required, claim: item.responseClaim }] : []);
}

type ConfiguredScenario = MigrationConfig['scenarios'][number];
export type ScenarioSide = 'source' | 'target';

/**
 * What the scenario means, independent of how each application is addressed: actions, values, order,
 * preconditions and completion. A binding may never change this projection.
 */
export function scenarioSemanticProjection(definition: ConfiguredScenario['definition']): unknown {
  return {
    unitId: definition.unitId, name: definition.name, description: definition.description,
    preconditions: definition.preconditions, testDataProfile: definition.testDataProfile,
    ...(definition.captureStepCheckpoints !== undefined ? { captureStepCheckpoints: definition.captureStepCheckpoints } : {}),
    serviceWorkers: definition.serviceWorkers ?? null, completionSignal: definition.completionSignal ?? null,
    steps: definition.steps.map(step => ({
      stepId: step.stepId, action: step.action, inputValue: step.inputValue ?? null,
      description: step.description ?? null, completionSignal: step.completionSignal ?? null,
      // Request steps carry their own semantics: method, path and body are shared by both sides.
      ...(step.action === 'request' ? { method: step.method ?? null, path: step.path ?? null, body: step.body ?? null } : {}),
    })),
  };
}

/** How one application is addressed: entry route, effective control locators and the unit's own scope. */
export function scenarioBindingProjection(scenario: ConfiguredScenario, side: ScenarioSide): unknown {
  const bound = scenario.bindings[side];
  return {
    entryUrl: bound.entryUrl, unitScope: bound.unitScope ?? null,
    steps: scenario.definition.steps.map(step => {
      const override = bound.steps.find(item => item.stepId === step.stepId);
      return { stepId: step.stepId, targetRole: override?.targetRole ?? step.targetRole, targetName: override?.targetName ?? step.targetName ?? null,
        ...((override?.targetLabel ?? step.targetLabel) !== undefined ? { targetLabel: override?.targetLabel ?? step.targetLabel } : {}) };
    }),
  };
}

export interface ResolvedScenario {
  /** Executable scenario for this application: same semantics, this side's route and locators. */
  definition: ConfiguredScenario['definition'];
  /** Scope used to evaluate unit assertions on this side, when the application declares one. */
  unitScope?: UnitScope;
}

/**
 * Apply one side's bindings to the shared scenario. Only the entry route and control identification change;
 * the resulting definition is re-validated and refused if the semantic projection would differ, so a binding
 * can adapt an integration but never rewrite an action, a value or the step sequence. A binding that names a
 * control the application does not have still fails at execution or leaves an assertion not evaluable — it
 * cannot hide a missing control.
 */
export function resolveScenarioForSide(config: unknown, scenarioId: string, side: ScenarioSide): ResolvedScenario {
  const parsed = parseMigrationConfig(config);
  const scenario = parsed.scenarios.find(item => item.definition.scenarioId === scenarioId);
  if (!scenario) throw new Error(`Unknown scenario ${scenarioId}`);
  const bound = scenario.bindings[side];
  const steps = scenario.definition.steps.map(step => {
    const override = bound.steps.find(item => item.stepId === step.stepId);
    return override ? { ...step, targetRole: override.targetRole, ...(override.targetName !== undefined ? { targetName: override.targetName } : {}),
      ...(override.targetLabel !== undefined ? { targetLabel: override.targetLabel } : {}) } : step;
  });
  const definition = ScenarioDefinitionSchema.parse({ ...scenario.definition, entryUrl: bound.entryUrl, steps }) as ConfiguredScenario['definition'];
  if (canonical(scenarioSemanticProjection(scenario.definition)) !== canonical(scenarioSemanticProjection(definition))) {
    throw new Error('A binding cannot change scenario semantics');
  }
  return { definition, ...(bound.unitScope ? { unitScope: bound.unitScope } : {}) };
}
