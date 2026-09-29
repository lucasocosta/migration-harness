import { z } from 'zod';
import { MigrationReferenceSchema } from './migration-reference.js';
import { ProjectCheckReportSchema } from './project-check.js';
import { ServedBuildIdentitySchema } from './served-build.js';
import { MigrationIdSchema, MigrationPathSchema, Sha256Schema } from './migration-config.js';

/**
 * One pinned source STATE_SNAPSHOT of a prepared reference: the identity a later verification must
 * reproduce before the source state can be trusted again. Absent from preparations whose configuration
 * declares no state captures, so historical documents keep their byte shape.
 */
const PinnedStateSnapshotSchema = z.object({
  captureId: MigrationIdSchema,
  checkpoint: z.enum(['AFTER_RESET', 'SCENARIO_END']),
  evidenceHash: Sha256Schema,
  projectionFingerprint: Sha256Schema,
  completeness: z.enum(['COMPLETE', 'INCOMPLETE']),
  path: MigrationPathSchema,
}).strict();

export const MigrationPreparationSchema = z.object({
  kind: z.literal('MIGRATION_PREPARATION'), version: z.literal('1'),
  status: z.enum(['PASS', 'FAIL', 'INCONCLUSIVE']),
  reference: MigrationReferenceSchema, referenceHash: Sha256Schema,
  artifactPath: MigrationPathSchema, keyId: Sha256Schema,
  sourceEvidence: z.array(z.object({ scenarioId: MigrationIdSchema, runIndex: z.number().int().nonnegative(),
    runId: z.string().min(1), traceHash: Sha256Schema, path: MigrationPathSchema,
    /** Pinned STATE_SNAPSHOT identities of this source run; omitted when the run declared no state captures. */
    state: z.array(PinnedStateSnapshotSchema).max(1000).optional() }).strict()).max(20000),
  baseline: ProjectCheckReportSchema.optional(), sourceBuild: ServedBuildIdentitySchema.optional(),
}).strict();
export type MigrationPreparation = z.infer<typeof MigrationPreparationSchema>;
export const parseMigrationPreparation = (value: unknown): MigrationPreparation => MigrationPreparationSchema.parse(value);
