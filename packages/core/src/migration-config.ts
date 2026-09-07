import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonical } from './normalization.js';
import { HarnessPolicySchema, ScenarioDefinitionSchema } from './schemas.js';
import { UnitAssertionBodySchema, UnitScopeSchema, type UnitAssertion, type UnitScope } from './unit-assertion.js';

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
}).strict();
const binding = z.object({
  entryUrl: httpUrl,
  steps: z.array(z.object({ stepId: MigrationIdSchema, targetRole: label, targetName: label.optional() }).strict()).max(1000),
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
}).strict();

export const MigrationConfigSchema = z.object({
  kind: z.literal('MIGRATION_CONFIG'), version: z.literal('1'), migrationId: MigrationIdSchema,
  source: project,
  target: project.extend({ writePaths: z.array(MigrationPathSchema).min(1).max(1000), protectedPaths: z.array(MigrationPathSchema).max(1000) }),
  scenarios: z.array(scenario).min(1).max(1000),
  checks: z.array(check).min(1).max(1000),
  requirements: z.array(requirement).max(10000),
  acceptedDifferences: z.array(z.object({
    id: MigrationIdSchema, scenarioId: MigrationIdSchema, description: label, decisionReference: label,
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
  if (value.requirements.some(item => item.origin === 'CRITICAL_CONTRACT') && !value.criticalContract) issue('Critical-contract requirement needs a contract reference');
  // The standard profile compares values, not only shapes: a configuration cannot opt out of that criterion.
  if (value.policy.network?.comparePayloadValues === false || value.policy.network?.compareResponseValues === false
    || value.policy.network?.comparePayloadShape === false || value.policy.network?.compareStatusCode === false
    || value.policy.network?.compareResponseShape === false) issue('Standard comparison criteria cannot be disabled by configuration');
  if (value.reset.kind === 'COMMANDS') {
    for (const side of ['source', 'target'] as const) if (!value[side].commands.some(command => command.id === (value.reset.kind === 'COMMANDS' ? value.reset[`${side}CommandId`] : '') && command.kind === 'reset')) issue('Reset must reference a reset command on each side');
  }
  for (const item of value.scenarios) {
    for (const mock of item.definition.preconditions.mockInitialApiResponses ?? []) if (!MigrationPathSchema.safeParse(mock.fixturePath).success) issue('Fixture must stay inside its scenario fixture root');
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
    serviceWorkers: definition.serviceWorkers ?? null, completionSignal: definition.completionSignal ?? null,
    steps: definition.steps.map(step => ({
      stepId: step.stepId, action: step.action, inputValue: step.inputValue ?? null,
      description: step.description ?? null, completionSignal: step.completionSignal ?? null,
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
      return { stepId: step.stepId, targetRole: override?.targetRole ?? step.targetRole, targetName: override?.targetName ?? step.targetName ?? null };
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
    return override ? { ...step, targetRole: override.targetRole, ...(override.targetName !== undefined ? { targetName: override.targetName } : {}) } : step;
  });
  const definition = ScenarioDefinitionSchema.parse({ ...scenario.definition, entryUrl: bound.entryUrl, steps }) as ConfiguredScenario['definition'];
  if (canonical(scenarioSemanticProjection(scenario.definition)) !== canonical(scenarioSemanticProjection(definition))) {
    throw new Error('A binding cannot change scenario semantics');
  }
  return { definition, ...(bound.unitScope ? { unitScope: bound.unitScope } : {}) };
}
