import { z } from 'zod';
import { Sha256Schema } from './migration-config.js';

export const ServedBuildIdentitySchema = z.object({
  kind: z.literal('SERVED_BUILD'), version: z.literal('1'),
  side: z.enum(['source', 'target']), runId: z.string().uuid(), origin: z.string().url(),
  configurationHash: Sha256Schema, inputHash: Sha256Schema, buildHash: Sha256Schema,
  fileCount: z.number().int().positive(), totalBytes: z.number().int().positive(),
}).strict();
export type ServedBuildIdentity = z.infer<typeof ServedBuildIdentitySchema>;
