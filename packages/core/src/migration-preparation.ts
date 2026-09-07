import { z } from 'zod';
import { MigrationReferenceSchema } from './migration-reference.js';
import { ProjectCheckReportSchema } from './project-check.js';
import { ServedBuildIdentitySchema } from './served-build.js';
import { MigrationIdSchema, MigrationPathSchema, Sha256Schema } from './migration-config.js';

export const MigrationPreparationSchema = z.object({
  kind: z.literal('MIGRATION_PREPARATION'), version: z.literal('1'),
  status: z.enum(['PASS', 'FAIL', 'INCONCLUSIVE']),
  reference: MigrationReferenceSchema, referenceHash: Sha256Schema,
  artifactPath: MigrationPathSchema, keyId: Sha256Schema,
  sourceEvidence: z.array(z.object({ scenarioId: MigrationIdSchema, runIndex: z.number().int().nonnegative(),
    runId: z.string().min(1), traceHash: Sha256Schema, path: MigrationPathSchema }).strict()).max(20000),
  baseline: ProjectCheckReportSchema.optional(), sourceBuild: ServedBuildIdentitySchema.optional(),
}).strict();
export type MigrationPreparation = z.infer<typeof MigrationPreparationSchema>;
export const parseMigrationPreparation = (value: unknown): MigrationPreparation => MigrationPreparationSchema.parse(value);
