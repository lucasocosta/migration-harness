import { z } from 'zod';
import { AriaRoleSchema, StorageMutationSchema, StorageTypeSchema } from './schemas.js';

/**
 * Unit-scoped semantic assertions.
 *
 * Differential comparison answers whether the destination preserved observed behavior; these assertions
 * answer whether required behavior holds at a named checkpoint inside the migrated unit. They are declared
 * by the owner, so every literal here is public configuration: the evaluator reports which assertion failed
 * and why, never the observed text or values it inspected. A scope that cannot be located, or a checkpoint
 * without evidence, is not evaluable — never a pass.
 */
const label = z.string().trim().min(1).max(4096);
const matchMode = z.enum(['EXACT', 'CONTAINS']);
const urlPattern = z.string().min(1).max(2048);
// Declared locally so this module stays free of a configuration import cycle.
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

export const UnitCheckpointSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('AFTER_STEP'), stepId: label }).strict(),
  z.object({ kind: z.literal('SCENARIO_END') }).strict(),
]);
/** Semantic boundary of the migrated unit; the destination shell outside it is irrelevant here. */
export const UnitScopeSchema = z.object({ role: AriaRoleSchema, name: label.optional(), nameMatch: matchMode.optional() }).strict();
const nodeState = z.object({
  disabled: z.boolean().optional(), invalid: z.union([z.boolean(), label]).optional(), checked: z.union([z.boolean(), label]).optional(),
  expanded: z.boolean().optional(), pressed: z.union([z.boolean(), label]).optional(), selected: z.boolean().optional(),
}).strict();
const nodeMatch = { role: AriaRoleSchema, name: label.optional(), nameMatch: matchMode.optional() };

export const UnitAssertionClaimSchema = z.discriminatedUnion('kind', [
  /** A control or message must exist, optionally with declared state flags and text. */
  z.object({ kind: z.literal('NODE_PRESENT'), ...nodeMatch, text: label.optional(), textMatch: matchMode.optional(), state: nodeState.optional() }).strict(),
  /** A control or message must not exist: an absent error, an absent forbidden control. */
  z.object({ kind: z.literal('NODE_ABSENT'), ...nodeMatch, text: label.optional(), textMatch: matchMode.optional() }).strict(),
  /** No matching request may leave the application in this checkpoint window: forbidden submission. */
  z.object({ kind: z.literal('NO_REQUEST'), method: label.optional(), pathPattern: urlPattern }).strict(),
  z.object({ kind: z.literal('REQUEST_OBSERVED'), method: label, pathPattern: urlPattern, requiredPayloadFields: z.array(label).max(1000).optional(),
    count: z.number().int().positive().max(1000).optional(),
    payloadValues: z.record(z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()])).optional(),
  }).strict(),
  z.object({ kind: z.literal('STORAGE_MUTATION'), storageType: StorageTypeSchema, key: label, mutationType: StorageMutationSchema, valuePattern: label.optional() }).strict(),
  z.object({ kind: z.literal('NAVIGATED'), pathPattern: urlPattern }).strict(),
  /**
   * Persistence, not just a correct request: the written values must come back from a later read of a
   * controlled backend. A read served by a declared mock cannot establish this and is not evaluable.
   */
  z.object({
    kind: z.literal('READ_BACK'), writeMethod: label, writePathPattern: urlPattern,
    readMethod: label.optional(), readPathPattern: urlPattern,
    fields: z.array(z.object({ payloadField: label, responseField: label }).strict()).min(1).max(100),
  }).strict(),
]);
/** Assertion body as declared on a configuration requirement, which supplies its id and enforcement. */
export const UnitAssertionBodySchema = z.object({
  checkpoint: UnitCheckpointSchema, scope: UnitScopeSchema.optional(), claim: UnitAssertionClaimSchema,
}).strict();
export const UnitAssertionSchema = UnitAssertionBodySchema.extend({ id: identifier, required: z.boolean() }).strict();

/**
 * API-surface requirement claim: a recorded HTTP exchange of the scenario must expose the structural
 * `path` (dot-separated keys) in its response body with the declared JSON type, or not expose it at all
 * when `absent` is declared. It is a separate vocabulary from the differential `UnitAssertionClaim` because
 * it is evaluated against recorded HTTP exchanges per side in quality-gates, never inside the ARIA/network
 * assertion pass; unevaluable evidence is INCONCLUSIVE, never a pass.
 */
export const ResponseFieldClaimSchema = z.object({
  kind: z.literal('RESPONSE_FIELD'),
  path: z.string().min(1).max(512).regex(/^[^\s.]+(?:\.[^\s.]+)*$/, 'Expected a dot-separated structural path such as data.email'),
  valueType: z.enum(['string', 'number', 'boolean', 'object', 'array', 'absent']),
}).strict();
/** Assertion body of a response-field requirement: its id and enforcement, mirroring `UnitAssertion`. */
export const ResponseFieldRequirementSchema = z.object({ id: identifier, required: z.boolean(), claim: ResponseFieldClaimSchema }).strict();

export const UnitAssertionOutcomeSchema = z.object({
  assertionId: identifier, side: z.enum(['source', 'target']), required: z.boolean(),
  status: z.enum(['SATISFIED', 'VIOLATED', 'NOT_EVALUABLE']),
  reason: z.enum(['CHECKPOINT_MISSING', 'CAPTURE_EMPTY', 'SCOPE_NOT_FOUND', 'NODE_MISSING', 'NODE_STATE_DIFFERS',
    'NODE_TEXT_DIFFERS', 'NODE_PRESENT_UNEXPECTED', 'REQUEST_OBSERVED_UNEXPECTED', 'REQUEST_MISSING',
    'PAYLOAD_FIELD_MISSING', 'PAYLOAD_VALUE_DIFFERS', 'REQUEST_COUNT_DIFFERS', 'STORAGE_MUTATION_MISSING', 'NAVIGATION_MISSING', 'WRITE_MISSING',
    'READ_BACK_MISSING', 'READ_BACK_VALUE_DIFFERS', 'READ_BACK_MOCKED',
    'STATE_NO_SNAPSHOT', 'STATE_INCOMPLETE', 'STATE_FIELD_MISSING', 'STATE_FIELD_DIFFERS', 'STATE_FIELD_UNEXPECTED', 'STATE_FIELD_AMBIGUOUS',
    'RESPONSE_FIELD_NO_EXCHANGE', 'RESPONSE_FIELD_AMBIGUOUS', 'RESPONSE_FIELD_MISSING', 'RESPONSE_FIELD_TYPE_DIFFERS']).optional(),
  /** Declared role of the inspected node, echoed from the assertion itself for localization. */
  role: AriaRoleSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.status === 'SATISFIED') !== (value.reason === undefined)) ctx.addIssue({ code: 'custom', message: 'A satisfied assertion has no reason and a failing one requires it' });
});

export type UnitCheckpoint = z.infer<typeof UnitCheckpointSchema>;
export type UnitScope = z.infer<typeof UnitScopeSchema>;
export type UnitAssertionClaim = z.infer<typeof UnitAssertionClaimSchema>;
export type UnitAssertionBody = z.infer<typeof UnitAssertionBodySchema>;
export type UnitAssertion = z.infer<typeof UnitAssertionSchema>;
export type UnitAssertionOutcome = z.infer<typeof UnitAssertionOutcomeSchema>;
export type ResponseFieldClaim = z.infer<typeof ResponseFieldClaimSchema>;
export type ResponseFieldRequirement = z.infer<typeof ResponseFieldRequirementSchema>;
export const parseUnitAssertion = (value: unknown): UnitAssertion => UnitAssertionSchema.parse(value);
export const parseUnitAssertions = (value: unknown): UnitAssertion[] => z.array(UnitAssertionSchema).max(10000).parse(value);
export const parseResponseFieldClaim = (value: unknown): ResponseFieldClaim => ResponseFieldClaimSchema.parse(value);
export const parseResponseFieldRequirements = (value: unknown): ResponseFieldRequirement[] => z.array(ResponseFieldRequirementSchema).max(10000).parse(value);
