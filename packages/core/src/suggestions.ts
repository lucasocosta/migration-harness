import { z } from 'zod';
import { MigrationIdSchema, MigrationPathSchema, Sha256Schema } from './migration-config.js';

/**
 * Non-authoritative suggestions produced by the harness (noise ranking, binding
 * adaptation, scenario inventory). Output-only: no writer applies these to
 * configuration, policy or reference. The owner decides; application remains a
 * config edit followed by update-migration-session / prepare --previous (RFC §7).
 */

export const SuggestionKindSchema = z.enum([
  'NOISE_PROPOSAL',
  'BINDING_ADAPTATION_PROPOSAL',
  'SCENARIO_INVENTORY_PROPOSAL',
  'VISUAL_VOLATILITY_PROPOSAL',
]);
export const SuggestionStatusSchema = z.literal('PROPOSED');

/** Structural pointer only (field path, stepId, scenarioId, checkpoint) — never runtime values. */
export const SuggestionTargetSchema = z.object({
  scenarioId: MigrationIdSchema.optional(),
  stepId: MigrationIdSchema.optional(),
  fieldPath: z.string().min(1).max(512).optional(),
  checkpointId: z.string().min(1).max(160).optional(),
  requestPath: z.string().min(1).max(512).optional(),
}).strict();

/** Machine-checkable fragment of existing policy or acceptedDifferences shapes. */
export const PolicySnippetSchema = z.object({
  kind: z.enum([
    'volatileQueryParams',
    'volatilePayloadFields',
    'volatileResponseFields',
    'volatilePathParams',
    'volatileStorageValues',
    'volatileWebSocketFields',
    'ignoredStorageKeys',
    'acceptedDifference',
  ]),
  /** Field or query key names, or the path template for path params. Values are structural identifiers only. */
  names: z.array(z.string().min(1).max(256)).max(100).optional(),
  storageType: z.enum(['localStorage', 'sessionStorage']).optional(),
  key: z.string().min(1).max(256).optional(),
  requestPath: z.string().min(1).max(512).optional(),
  method: z.string().min(1).max(16).optional(),
  matchCode: z.enum(['NETWORK_PAYLOAD_VALUE_MISMATCH', 'NETWORK_MISSING_REQUEST']).optional(),
}).strict();

export const SuggestionSchema = z.object({
  suggestionId: MigrationIdSchema,
  kind: SuggestionKindSchema,
  status: SuggestionStatusSchema,
  /** Heuristic ranking only; never a confidence that can override evidence. */
  rank: z.number().min(0).max(1),
  observedFrequency: z.number().min(0).max(1).optional(),
  runCount: z.number().int().min(2).max(20).optional(),
  codes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(160)).max(50).optional(),
  target: SuggestionTargetSchema,
  policySnippet: PolicySnippetSchema.optional(),
  evidencePaths: z.array(MigrationPathSchema).max(100).optional(),
  description: z.string().min(1).max(2000),
}).strict();

export const SuggestionReportSchema = z.object({
  kind: z.literal('SUGGESTION_REPORT'),
  version: z.literal('1'),
  generatedAt: z.string().datetime({ offset: true }),
  scenarioId: MigrationIdSchema.optional(),
  suggestions: z.array(SuggestionSchema).max(1000),
  /** Disclosure that suggestions are non-authoritative and never auto-applied. */
  authority: z.literal('HINT_ONLY'),
}).strict();

export type SuggestionKind = z.infer<typeof SuggestionKindSchema>;
export type Suggestion = z.infer<typeof SuggestionSchema>;
export type SuggestionReport = z.infer<typeof SuggestionReportSchema>;
export type PolicySnippet = z.infer<typeof PolicySnippetSchema>;
export const parseSuggestionReport = (value: unknown): SuggestionReport => SuggestionReportSchema.parse(value);

/**
 * detailCodes that only carry suggestions/advisory evidence. They must never
 * drive a session disposition toward FIX_ENVIRONMENT by themselves.
 */
export const SUGGESTION_DETAIL_CODES: readonly string[] = [
  'NOISE_PROPOSAL',
  'BINDING_ADAPTATION_PROPOSAL',
  'SCENARIO_INVENTORY_PROPOSAL',
  'VISUAL_MISMATCH',
  'VISUAL_VOLATILITY_PROPOSAL',
];

export function isSuggestionOnlyDiagnostic(item: { code: string; detailCode?: string | undefined }): boolean {
  return item.detailCode !== undefined
    && SUGGESTION_DETAIL_CODES.includes(item.detailCode)
    && (item.code === 'STANDARD_WARNING' || item.code === 'LEGACY_WARNING' || item.code === 'MOCKED_COVERAGE');
}
