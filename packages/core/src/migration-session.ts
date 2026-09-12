import { z } from 'zod';
import { MigrationConfigSchema, MigrationPathSchema, Sha256Schema } from './migration-config.js';
import { MigrationPreparationSchema } from './migration-preparation.js';

export const ScopeEntrySchema = z.object({
  path: MigrationPathSchema.optional(), opaqueId: Sha256Schema.optional(),
  kind: z.enum(['FILE', 'DIRECTORY', 'LINK', 'OPAQUE']), sha256: Sha256Schema,
}).strict().refine(value => (value.kind === 'OPAQUE') === !!value.opaqueId && (!!value.path !== !!value.opaqueId), 'Invalid scope entry identity');
export const ProjectScopeSnapshotSchema = z.object({ root: MigrationPathSchema, entries: z.array(ScopeEntrySchema).max(20000), hash: Sha256Schema }).strict();
export const MigrationScopeSnapshotSchema = z.object({ source: ProjectScopeSnapshotSchema, target: ProjectScopeSnapshotSchema }).strict();
export const ScopeFindingSchema = z.object({
  side: z.enum(['source', 'target']), path: MigrationPathSchema.optional(),
  code: z.enum(['SOURCE_CHANGED', 'OUTSIDE_WRITE_SCOPE', 'LINK_NOT_ALLOWED', 'PRIVATE_ENTRY_CHANGED']),
  change: z.enum(['ADDED', 'REMOVED', 'MODIFIED']),
}).strict();
export const MigrationSessionSchema = z.object({
  kind: z.literal('MIGRATION_SESSION'), version: z.literal('1'), profile: z.literal('standard'),
  createdAt: z.string().datetime(), configurationHash: Sha256Schema, workspaceHash: Sha256Schema,
  config: MigrationConfigSchema, preparation: MigrationPreparationSchema, scope: MigrationScopeSnapshotSchema,
  maxAttempts: z.number().int().min(1).max(101), maxActiveMs: z.number().int().positive(),
}).strict();
export const SessionAttemptStartSchema = z.object({
  index: z.number().int().nonnegative(), startedAt: z.string().datetime(), previousHash: Sha256Schema,
  candidateHash: Sha256Schema, remainingMs: z.number().int().positive(), generation: z.number().int().nonnegative().optional(),
}).strict();
export const SessionAttemptFinishSchema = z.object({
  index: z.number().int().nonnegative(), startHash: Sha256Schema, finishedAt: z.string().datetime(), durationMs: z.number().int().nonnegative(),
  outcome: z.enum(['PASS', 'FAIL', 'INCONCLUSIVE', 'REFUSED_SCOPE']),
  fingerprint: Sha256Schema, candidateHash: Sha256Schema,
  reportPath: MigrationPathSchema.optional(), reportHash: Sha256Schema.optional(),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(), findings: z.array(ScopeFindingSchema),
  generation: z.number().int().nonnegative().optional(),
}).strict().refine(value => !!value.reportPath === !!value.reportHash
  && (value.outcome !== 'PASS' || !!value.reportPath && !value.errorCode && !value.findings.length), 'Invalid attempt evidence');
/** One persisted reference generation: an approved coverage/binding update that preserves session identity, scope governance and budgets. */
export const SessionGenerationSchema = z.object({
  index: z.number().int().nonnegative(), createdAt: z.string().datetime(),
  configurationHash: Sha256Schema, referenceHash: Sha256Schema, scopeHash: Sha256Schema, previousHash: Sha256Schema,
  config: MigrationConfigSchema, preparation: MigrationPreparationSchema, scope: MigrationScopeSnapshotSchema,
}).strict();
export const SessionGenerationsSchema = z.object({
  kind: z.literal('MIGRATION_SESSION_GENERATIONS'), version: z.literal('1'),
  sessionHash: Sha256Schema, entries: z.array(SessionGenerationSchema).max(1000),
}).strict();
export type ScopeEntry = z.infer<typeof ScopeEntrySchema>;
export type MigrationScopeSnapshot = z.infer<typeof MigrationScopeSnapshotSchema>;
export type ScopeFinding = z.infer<typeof ScopeFindingSchema>;
export type MigrationSession = z.infer<typeof MigrationSessionSchema>;
export type SessionAttemptStart = z.infer<typeof SessionAttemptStartSchema>;
export type SessionAttemptFinish = z.infer<typeof SessionAttemptFinishSchema>;
export type SessionGeneration = z.infer<typeof SessionGenerationSchema>;
export type SessionGenerations = z.infer<typeof SessionGenerationsSchema>;
export const parseSessionGeneration = (value: unknown): SessionGeneration => SessionGenerationSchema.parse(value);
export const parseSessionGenerations = (value: unknown): SessionGenerations => SessionGenerationsSchema.parse(value);
