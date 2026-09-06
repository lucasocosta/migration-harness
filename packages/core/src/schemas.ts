import { z } from 'zod';
import type { BehaviorContract } from './behavior-contract.js';
import type { ScenarioDefinition, ScenarioFrameShape } from './scenario.js';
import type { RawObservedTrace, SanitizedObservedTrace } from './trace-events.js';
import type { TransformationManifest } from './transformation-manifest.js';
import type { TransformationPlan } from './transformation-plan.js';
import type { EquivalenceResult } from './equivalence-result.js';
import type { MigrationUnit } from './migration-unit.js';

const id = z.string().min(1).max(512);
const text = z.string().max(1_000_000);
const strings = z.array(id).max(10000);
const record = z.record(text);
const json: z.ZodType<unknown> = z.lazy(() => z.union([z.null(), z.boolean(), z.number().finite(), text, z.array(json), z.record(json)]));
const object = z.record(json);
const time = z.string().datetime({ offset: true });
const severity = z.enum(['BLOCKING', 'WARNING', 'INFORMATIONAL']);
const action = z.enum(['click', 'fill', 'select', 'press', 'focus']);
const storageType = z.enum(['localStorage', 'sessionStorage']);
const mutationType = z.enum(['SET', 'REMOVE', 'CLEAR']);
const role = z.enum(['alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption', 'cell', 'checkbox', 'code', 'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition', 'deletion', 'dialog', 'directory', 'document', 'emphasis', 'feed', 'figure', 'form', 'generic', 'grid', 'gridcell', 'group', 'heading', 'img', 'insertion', 'link', 'list', 'listbox', 'listitem', 'log', 'main', 'marquee', 'math', 'meter', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'navigation', 'none', 'note', 'option', 'paragraph', 'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider', 'spinbutton', 'status', 'strong', 'subscript', 'superscript', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox', 'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem']);
const timeoutMs = z.number().int().positive().max(300000);
const frameShape: z.ZodType<ScenarioFrameShape> = z.lazy(() => z.record(z.union([z.enum(['any', 'string', 'number', 'boolean', 'null', 'object', 'array']), frameShape])));
const wsDirection = z.enum(['sent', 'received']);
export const CompletionSignalSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('LOCATOR_VISIBLE'), targetRole: role, targetName: text.optional(), timeoutMs }).strict(),
  z.object({ type: z.literal('RESPONSE_RECEIVED'), responseUrlPattern: id, responseMethod: id, timeoutMs }).strict(),
  z.object({ type: z.literal('STORAGE_KEY_SET'), storageType, storageKey: id, timeoutMs }).strict(),
  z.object({ type: z.literal('WEBSOCKET_FRAME'), urlPattern: id, direction: wsDirection, payloadShape: frameShape, timeoutMs }).strict(),
]);
const step = z.object({ stepId: id, action, targetRole: role, targetName: text.optional(), inputValue: text.optional(), description: text.optional(), completionSignal: CompletionSignalSchema.optional() }).strict();
export const ScenarioDefinitionSchema = z.object({
  scenarioId: id, unitId: id, name: id, description: text, entryUrl: z.string().url(),
  preconditions: z.object({
    storageInitialState: z.object({ local: record.optional(), session: record.optional() }).strict().optional(),
    mockInitialApiResponses: z.array(z.object({ urlPattern: id, method: id, statusCode: z.number().int().min(100).max(599), fixturePath: id }).strict()).optional(),
  }).strict(),
  steps: z.array(step).max(1000), completionSignal: CompletionSignalSchema.optional(),
  serviceWorkers: z.enum(['block', 'allow']).optional(),
  testDataProfile: z.enum(['standard', 'edge_case', 'error_flow']),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.steps.map(item => item.stepId)).size !== value.steps.length) ctx.addIssue({ code: 'custom', message: 'Duplicate stepId' });
  for (const item of value.steps) if (['fill', 'select', 'press'].includes(item.action) && item.inputValue === undefined) ctx.addIssue({ code: 'custom', message: `${item.stepId} requires inputValue` });
  // 'allow' is meaningless without at least one real http(s) origin for a worker to control; the entry URL is the scenario-carried origin.
  if (value.serviceWorkers === 'allow') {
    let protocol = '';
    try { protocol = new URL(value.entryUrl).protocol; } catch { ctx.addIssue({ code: 'custom', message: 'serviceWorkers allow requires a parseable entryUrl origin' }); }
    if (protocol && protocol !== 'http:' && protocol !== 'https:') ctx.addIssue({ code: 'custom', message: 'serviceWorkers allow requires at least one http(s) origin' });
  }
});

const base = { eventId: id, timestampMs: z.number().finite().nonnegative(), sequenceIndex: z.number().int().nonnegative(), correlationId: id.optional(), causedByEventIds: strings.optional() };
export const TraceEventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('USER_INTERACTION'), stepId: id, action, targetAriaRole: id, targetAriaName: text.optional(), inputValue: text.optional() }).strict(),
  z.object({ ...base, type: z.literal('HTTP_REQUEST'), method: id, url: z.string().url(), headers: record, payload: json }).strict(),
  z.object({ ...base, type: z.literal('HTTP_RESPONSE'), method: id, url: z.string().url(), statusCode: z.number().int().min(100).max(599), headers: record, body: json, requestToResponseEndMs: z.number().nonnegative(), servedByServiceWorker: z.boolean().optional() }).strict(),
  z.object({ ...base, type: z.literal('HTTP_FAILED'), method: id, url: z.string().url(), errorText: text }).strict(),
  z.object({ ...base, type: z.literal('NAVIGATION'), fromUrl: z.string().url(), toUrl: z.string().url() }).strict(),
  z.object({ ...base, type: z.literal('ARIA_STATE_CHANGE'), triggerEventId: id, rawYamlTree: text, jsonTree: object }).strict(),
  z.object({ ...base, type: z.literal('STORAGE_DELTA'), storageType, mutationType, key: text, previousValue: text.nullable(), newValue: text.nullable() }).strict(),
  z.object({ ...base, type: z.literal('WEBSOCKET_FRAME'), url: z.string().url(), direction: wsDirection, payload: json }).strict(),
]);
const trace = z.object({ scenarioId: id, runId: id.optional(), runIndex: z.number().int().nonnegative(), startedAt: time, events: z.array(TraceEventSchema).max(100000),
  environment: z.object({ browser: id, viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict(), locale: id }).strict(),
  completion: z.object({ status: z.enum(['COMPLETED', 'FAILED']), completedStepIds: strings }).strict().optional(),
}).strict();
function validateTrace(value: z.infer<typeof trace>, ctx: z.RefinementCtx): void {
  const ids = new Set<string>();
  let sequence = -1;
  const requests = new Map<string, string>();
  const terminals = new Set<string>();
  for (const event of value.events) {
    if (ids.has(event.eventId) || event.sequenceIndex <= sequence) ctx.addIssue({ code: 'custom', message: 'Duplicate event or non-increasing sequenceIndex' });
    for (const parent of event.causedByEventIds ?? []) if (!ids.has(parent)) ctx.addIssue({ code: 'custom', message: 'Causal parent must precede event' });
    ids.add(event.eventId); sequence = event.sequenceIndex;
    if (event.type.startsWith('HTTP_')) {
      if (!event.correlationId) { ctx.addIssue({ code: 'custom', message: 'HTTP event requires correlationId' }); continue; }
      if (event.type === 'HTTP_REQUEST') {
        if (requests.has(event.correlationId)) ctx.addIssue({ code: 'custom', message: 'Duplicate request correlationId' });
        requests.set(event.correlationId, `${event.method} ${event.url}`);
      } else if (event.type === 'HTTP_RESPONSE' || event.type === 'HTTP_FAILED') {
        if (requests.get(event.correlationId) !== `${event.method} ${event.url}` || terminals.has(event.correlationId)) ctx.addIssue({ code: 'custom', message: 'Orphan or duplicate terminal HTTP event' });
        terminals.add(event.correlationId);
      }
    }
  }
}
export const RawObservedTraceSchema = trace.superRefine(validateTrace);
export const SanitizedObservedTraceSchema = trace.extend({ sanitization: z.object({ version: id, appliedAt: time, redactionsCount: z.number().int().nonnegative() }).strict() }).strict().superRefine(validateTrace);
const evidence = z.object({ source: z.enum(['RUNTIME_OBSERVATION', 'STATIC_ANALYSIS', 'OPENAPI', 'EXISTING_TESTS', 'HUMAN_SPECIFICATION']), evidenceConfidenceHeuristic: z.number().min(0).max(1), runsObservedCount: z.number().int().nonnegative().optional(), totalRunsEvaluated: z.number().int().positive().optional(), sourceReference: id.optional() }).strict();
const invariant = <T extends z.ZodTypeAny>(value: T) => z.object({ id, value, evidenceTrail: z.array(evidence).min(1), enforcement: severity }).strict();
export const HttpEndpointInvariantSchema = z.object({ pathTemplate: id, pathParams: z.record(z.object({ type: z.enum(['string', 'number', 'uuid']), pattern: text.optional() }).strict()),
  queryParams: z.object({ required: strings, optional: strings, ignored: strings }).strict(), method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  payloadRequirements: z.object({ observedAlwaysFields: strings, observedSometimesFields: strings, requiredFields: strings, optionalFields: strings, ignoredVolatileFields: strings }).strict(),
  responseExpectations: z.object({ allowedStatusCodes: z.array(z.number().int().min(100).max(599)), bodyShapeRequiredKeys: strings.optional() }).strict(),
  causalDependencies: z.object({ afterOperationIds: strings, triggerStepId: id.optional() }).strict(),
}).strict();
export const HttpEvidenceBundleSchema = z.object({ invariants: z.array(invariant(HttpEndpointInvariantSchema)), unresolved: z.array(z.object({ reference: id, reason: text }).strict()) }).strict();
export const BehaviorContractSchema = z.object({ unitId: id, contractId: id, version: id, status: z.enum(['DRAFT', 'REVIEW', 'APPROVED', 'DEPRECATED']),
  integrity: z.object({ contentHash: z.string(), algorithm: z.literal('sha256'), approvedBy: id.optional(), approvedAt: time.optional() }).strict(),
  scenarios: z.array(z.object({ scenarioId: id, invariants: z.object({ network: z.array(invariant(HttpEndpointInvariantSchema)), accessibilityAriaYaml: invariant(text).optional(), accessibilityAriaJson: invariant(object).optional(),
    navigation: z.array(invariant(z.object({ destination: id }).strict())).optional(),
    storageDeltas: z.array(invariant(z.array(z.object({ storageType, mutationType, key: text, expectedPattern: text.optional() }).strict()))),
  }).strict() }).strict()).min(1),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.scenarios.map(s => s.scenarioId)).size !== value.scenarios.length) ctx.addIssue({ code: 'custom', message: 'Duplicate contract scenario' });
  if (value.status === 'APPROVED' && (!value.integrity.approvedBy?.trim() || !value.integrity.approvedAt || !/^[a-f0-9]{64}$/.test(value.integrity.contentHash))) ctx.addIssue({ code: 'custom', message: 'Approved contract requires reviewer, timestamp and SHA-256' });
});
export const TransformationManifestSchema = z.object({ unitId: id, generatedAt: time, transformer: z.object({ kind: z.enum(['CODEMOD', 'LLM', 'HYBRID', 'MANUAL']), name: id, version: id.optional() }).strict(),
  mappings: z.array(z.object({ mappingId: id, source: id, target: id, preserves: z.array(z.enum(['HTTP_METHOD', 'HTTP_PATH', 'HTTP_PAYLOAD', 'HTTP_STATUS', 'VALIDATION', 'SUCCESS_BEHAVIOR', 'ERROR_BEHAVIOR', 'NAVIGATION', 'STORAGE', 'ARIA_SEMANTICS'])), rationale: text.optional() }).strict()),
}).strict();
export const TransformationPlanSchema = z.object({ unitId: id, createdAt: time, items: z.array(z.object({ sourceSymbol: id, targetConcept: id, transformationClass: z.enum(['STRUCTURE_PRESERVING', 'STRUCTURE_CHANGING', 'BEHAVIORAL_REIMPLEMENTATION']), mechanism: z.enum(['CODEMOD', 'LLM', 'MANUAL']), rationale: id }).strict()) }).strict();
const dimension = z.enum(['NETWORK', 'NAVIGATION', 'STATE', 'ARIA', 'CONTRACT', 'SECURITY']);
export const EquivalenceResultSchema = z.object({ scenarioId: id, status: z.enum(['EQUIVALENT', 'NOT_EQUIVALENT']), evaluatedAt: time,
  divergences: z.array(z.object({ divergenceId: id, scenarioId: id, dimension, code: id, severity, message: text, source: json.optional(), target: json.optional(), relatedMappingId: id.optional() }).strict()),
  evidence: z.object({ sourceEventCount: z.number().int().nonnegative(), targetEventCount: z.number().int().nonnegative(), evaluatedDimensions: z.array(dimension), transformationManifestUsedAsHint: z.boolean() }).strict(),
}).strict().refine(value => (value.status === 'NOT_EQUIVALENT') === value.divergences.some(d => d.severity === 'BLOCKING'), 'Status contradicts blocking divergences')
  .refine(value => new Set(value.divergences.map(d => d.divergenceId)).size === value.divergences.length, 'Duplicate divergence ids');

// Parse at IO boundaries; explicit return types preserve exact optional properties.
export const parseScenario = (value: unknown): ScenarioDefinition => ScenarioDefinitionSchema.parse(value) as ScenarioDefinition;
export const parseRawTrace = (value: unknown): RawObservedTrace => RawObservedTraceSchema.parse(value) as RawObservedTrace;
export const parseSanitizedTrace = (value: unknown): SanitizedObservedTrace => SanitizedObservedTraceSchema.parse(value) as SanitizedObservedTrace;
export const parseContract = (value: unknown): BehaviorContract => BehaviorContractSchema.parse(value) as BehaviorContract;
export const parseManifest = (value: unknown): TransformationManifest => TransformationManifestSchema.parse(value) as TransformationManifest;
export const parsePlan = (value: unknown): TransformationPlan => TransformationPlanSchema.parse(value) as TransformationPlan;
export const parseEquivalenceResult = (value: unknown): EquivalenceResult => EquivalenceResultSchema.parse(value) as EquivalenceResult;

const streamSemantics = z.enum(['request-response', 'event-stream', 'state-stream', 'cancellation-sensitive', 'orchestration']);
export const MigrationUnitSchema = z.object({ id, version: id, runtimeRoutes: strings,
  symbols: z.array(z.object({ id, name: id, kind: z.enum(['component', 'service', 'directive', 'pipe', 'guard', 'resolver', 'module', 'template_embedded_view', 'type_definition']), filePath: id, exported: z.boolean(), astHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
  dependencyGraph: z.array(z.object({ fromSymbolId: id, toSymbolId: id, relation: z.enum(['imports', 'injects', 'renders', 'applies_directive', 'pipes_through', 'guards', 'resolves']), isDynamic: z.boolean() }).strict()),
  inputs: z.array(z.object({ symbolId: id, name: id, alias: id.optional(), type: id }).strict()),
  outputs: z.array(z.object({ symbolId: id, name: id, alias: id.optional(), eventType: id }).strict()),
  reactiveForms: z.array(z.object({ symbolId: id, formsSymbols: strings, templateDirectives: strings, controls: strings, validators: strings, hasAsyncValidators: z.boolean(), hasFormArray: z.boolean(), hasDynamicControlCreation: z.boolean(), subscriptions: z.array(z.object({ source: id, semantics: streamSemantics }).strict()).max(10000), builderInferred: z.boolean(), asyncValidatorEvidence: z.array(z.object({ field: id, validators: strings, scope: z.enum(['local', 'imported', 'unknown']) }).strict()).max(10000) }).strict()),
  providerScopes: z.array(z.object({ symbolId: id, providedIn: z.enum(['root', 'platform', 'any', 'type', 'unknown', 'none']), token: id.optional(), componentProviders: strings }).strict()),
  boundary: z.object({ entrypoints: strings, internalSymbols: strings, externalDependencies: z.array(z.object({ name: id, targetPackage: id, resolvedStrategy: z.enum(['keep_external', 'polyfilled', 'mocked_in_harness']) }).strict()) }).strict(),
  resolutionMetrics: z.object({ totalSymbolsIdentified: z.number().int().nonnegative(), resolvedSymbolsCount: z.number().int().nonnegative(), resolutionCoverage: z.number().min(0).max(1), unresolvedSymbols: z.array(z.object({ name: id, requestedBy: id, reason: id }).strict()), dynamicEdgesCount: z.number().int().nonnegative() }).strict(),
  metadata: z.object({ loc: z.number().int().nonnegative(), cyclomaticComplexity: z.number().int().nonnegative(), hasRxjsStreams: z.boolean(), hasDynamicForms: z.boolean(), templateAstComplexityScore: z.number().nonnegative() }).strict(),
}).strict().superRefine((value, ctx) => {
  const ids = new Set(value.symbols.map(s => s.id));
  if (ids.size !== value.symbols.length || [...value.boundary.entrypoints, ...value.boundary.internalSymbols].some(id => !ids.has(id)) || value.dependencyGraph.some(e => !ids.has(e.fromSymbolId) || !ids.has(e.toSymbolId))) ctx.addIssue({ code: 'custom', message: 'Invalid migration boundary or graph reference' });
  const kinds = new Map(value.symbols.map(s => [s.id, s.kind]));
  if ([...value.inputs, ...value.outputs, ...value.reactiveForms].some(item => kinds.get(item.symbolId) !== 'component')) ctx.addIssue({ code: 'custom', message: 'Decorated IO and reactive forms must reference component symbols' });
  if (new Set(value.reactiveForms.map(f => f.symbolId)).size !== value.reactiveForms.length) ctx.addIssue({ code: 'custom', message: 'Duplicate reactive forms record' });
  if (value.providerScopes.some(p => !ids.has(p.symbolId))) ctx.addIssue({ code: 'custom', message: 'Provider scope references an unknown symbol' });
  if (new Set(value.providerScopes.map(p => p.symbolId)).size !== value.providerScopes.length) ctx.addIssue({ code: 'custom', message: 'Duplicate provider scope record' });
});
export const parseMigrationUnit = (value: unknown): MigrationUnit => MigrationUnitSchema.parse(value) as MigrationUnit;

export const HarnessPolicySchema = z.object({
  network: z.object({ volatileQueryParams: strings.optional(), volatilePayloadFields: strings.optional(), volatileResponseFields: strings.optional(), volatilePathParams: z.record(strings).optional(), pathTemplates: strings.optional(), comparePayloadShape: z.boolean().optional(), compareStatusCode: z.boolean().optional(), compareResponseShape: z.boolean().optional() }).strict().optional(),
  observables: z.object({ volatileQueryParams: strings.optional(), ignoredStorageKeys: strings.optional(), volatileStorageValues: z.array(z.object({ storageType, key: id }).strict()).optional(), ariaSeverity: severity.optional(), navigationAliases: record.optional() }).strict().optional(),
  websockets: z.object({ volatileWebSocketFields: strings.optional() }).strict().optional(),
  sanitization: z.object({ allowedPayloadKeys: strings.optional(), allowedStorageKeys: strings.optional(), sensitiveKeys: strings.optional() }).strict().optional(),
  assistant: z.object({ allowedPackages: strings, targetConventions: z.record(z.string().max(4096)).optional(), maxBriefBytes: z.number().int().positive().max(4_000_000).optional(), maxSubmissionBytes: z.number().int().positive().max(10_000_000).optional(), typecheck: z.boolean().optional(), lint: z.boolean().optional() }).strict().optional(),
  allowedOrigins: z.array(z.string().url()).optional(),
}).strict();
