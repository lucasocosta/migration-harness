import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonical } from './normalization.js';
import { BehaviorContractSchema, MigrationUnitSchema, TransformationPlanSchema, TransformationManifestSchema } from './schemas.js';
import type { BehaviorContract } from './behavior-contract.js';
import type { MigrationUnit } from './migration-unit.js';
import type { TransformationManifest } from './transformation-manifest.js';
import type { TransformationPlan } from './transformation-plan.js';

export type BriefTask = 'TRANSFORM' | 'REPAIR';
export type BriefKind = 'TRANSFORM_BRIEF' | 'REPAIR_BRIEF';

export interface BriefAllowedFile { path: string; sha256: string; exists: boolean; }
export interface BriefScenarioMeta { scenarioId: string; name: string; description: string; testDataProfile: 'standard' | 'edge_case' | 'error_flow'; }
export interface BriefFailure { code: string; dimension: string; message: string; source?: unknown; target?: unknown; }
export interface BriefRepair { failure: BriefFailure; editBudgetBytes: number; attempt: number; maxAttempts: number; }
export interface BriefSubmissionFormat { patches: string; manifest: string; instructions: string; }
export interface TransformBrief {
  kind: BriefKind;
  briefVersion: '1';
  briefId: string;
  unitId: string;
  generatedAt: string;
  task: BriefTask;
  plan: TransformationPlan;
  unit: MigrationUnit;
  contract: BehaviorContract;
  scenarios: BriefScenarioMeta[];
  trace: { kind: 'LLM_SAFE_TRACE'; events: unknown[] };
  allowedFiles: BriefAllowedFile[];
  contextFiles: string[];
  allowedPackages: string[];
  targetConventions?: Record<string, string>;
  submission: { format: BriefSubmissionFormat; command: string };
  repair?: BriefRepair;
}

export interface SubmissionPatch { path: string; beforeHash: string; content: string; }
export interface Submission { briefId: string; patches: SubmissionPatch[]; manifest: TransformationManifest; }

export type ApplyRefusalCode =
  | 'PATCH_PATH_OUTSIDE_BOUNDARY'
  | 'BASELINE_HASH_MISMATCH'
  | 'AST_FORBIDDEN_CONSTRUCT'
  | 'IMPORT_NOT_ALLOWED'
  | 'PSEUDONYM_IN_PATCH'
  | 'RAW_PATH_REFERENCE'
  | 'SCHEMA_INVALID'
  | 'MANIFEST_UNIT_MISMATCH'
  | 'BRIEF_ID_MISMATCH'
  | 'EDIT_BUDGET_EXCEEDED';

export interface ApplyRefusal { code: ApplyRefusalCode; message: string; path?: string; }
export interface ApplyResult {
  kind: 'APPLY_RESULT';
  briefId: string;
  unitId: string;
  status: 'PASS' | 'REFUSED';
  refusals: ApplyRefusal[];
  appliedFiles: string[];
  next?: { command: string };
}

const id = z.string().min(1).max(512);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const json: z.ZodType<unknown> = z.lazy(() => z.union([z.null(), z.boolean(), z.number().finite(), z.string().max(1_000_000), z.array(json), z.record(json)]));
const time = z.string().datetime({ offset: true });

export const BriefAllowedFileSchema = z.object({ path: id, sha256: hash, exists: z.boolean() }).strict();
export const TransformBriefSchema = z.object({
  kind: z.enum(['TRANSFORM_BRIEF', 'REPAIR_BRIEF']),
  briefVersion: z.literal('1'),
  briefId: z.string().regex(/^b_[a-f0-9]{64}$/),
  unitId: id,
  generatedAt: time,
  task: z.enum(['TRANSFORM', 'REPAIR']),
  plan: TransformationPlanSchema,
  unit: MigrationUnitSchema,
  contract: BehaviorContractSchema,
  scenarios: z.array(z.object({ scenarioId: id, name: id, description: z.string().max(1_000_000), testDataProfile: z.enum(['standard', 'edge_case', 'error_flow']) }).strict()).min(1).max(1000),
  trace: z.object({ kind: z.literal('LLM_SAFE_TRACE'), events: z.array(json).max(100000) }).strict(),
  allowedFiles: z.array(BriefAllowedFileSchema).min(1).max(10000),
  contextFiles: z.array(id).max(10000),
  allowedPackages: z.array(id).max(1000),
  targetConventions: z.record(z.string().max(4096)).optional(),
  submission: z.object({ format: z.object({ patches: z.string().max(10000), manifest: z.string().max(10000), instructions: z.string().max(10000) }).strict(), command: z.string().max(4096) }).strict(),
  repair: z.object({ failure: z.object({ code: id, dimension: z.enum(['NETWORK', 'NAVIGATION', 'STATE', 'ARIA', 'CONTRACT', 'SECURITY']), message: z.string().max(1_000_000), source: json.optional(), target: json.optional() }).strict(), editBudgetBytes: z.number().int().positive().max(65536), attempt: z.number().int().positive(), maxAttempts: z.number().int().positive().max(10) }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.kind === 'REPAIR_BRIEF') !== (value.task === 'REPAIR') || (value.kind === 'REPAIR_BRIEF') !== (value.repair !== undefined)) ctx.addIssue({ code: 'custom', message: 'kind, task and repair payload must agree' });
  if (value.plan.unitId !== value.unitId || value.unit.id !== value.unitId || value.contract.unitId !== value.unitId) ctx.addIssue({ code: 'custom', message: 'Brief payload unitIds must match the brief unitId' });
  const scenarioIds = new Set(value.scenarios.map(item => item.scenarioId));
  if (value.contract.scenarios.some(item => !scenarioIds.has(item.scenarioId)) || [...scenarioIds].some(item => !value.contract.scenarios.some(contract => contract.scenarioId === item))) ctx.addIssue({ code: 'custom', message: 'Brief scenarios must match the contract scenario set' });
});

export const SubmissionSchema = z.object({
  briefId: z.string().regex(/^b_[a-f0-9]{64}$/),
  patches: z.array(z.object({ path: z.string().min(1).max(4096), beforeHash: hash, content: z.string().max(2_000_000) }).strict()).min(1).max(100),
  manifest: TransformationManifestSchema,
}).strict();

export const ApplyResultSchema = z.object({
  kind: z.literal('APPLY_RESULT'),
  briefId: z.string().min(1).max(512),
  unitId: z.string().max(512),
  status: z.enum(['PASS', 'REFUSED']),
  refusals: z.array(z.object({ code: z.enum(['PATCH_PATH_OUTSIDE_BOUNDARY', 'BASELINE_HASH_MISMATCH', 'AST_FORBIDDEN_CONSTRUCT', 'IMPORT_NOT_ALLOWED', 'PSEUDONYM_IN_PATCH', 'RAW_PATH_REFERENCE', 'SCHEMA_INVALID', 'MANIFEST_UNIT_MISMATCH', 'BRIEF_ID_MISMATCH', 'EDIT_BUDGET_EXCEEDED']), message: z.string().max(10000), path: z.string().max(4096).optional() }).strict()).max(1000),
  appliedFiles: z.array(z.string().max(4096)).max(1000),
  next: z.object({ command: z.string().max(4096) }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.status === 'PASS') !== (value.refusals.length === 0)) ctx.addIssue({ code: 'custom', message: 'PASS requires zero refusals; REFUSED requires at least one' });
  if (value.status === 'PASS' && (!value.next || !value.appliedFiles.length)) ctx.addIssue({ code: 'custom', message: 'PASS requires applied files and a next command' });
  if (value.status === 'REFUSED' && value.appliedFiles.length) ctx.addIssue({ code: 'custom', message: 'REFUSED must not report applied files' });
});

/** briefId is tamper-evident: the sha256 of the canonical brief content, excluding the briefId field itself. */
export function computeBriefId(brief: Omit<TransformBrief, 'briefId'> | TransformBrief): string {
  const { briefId: _ignored, ...rest } = structuredClone(brief) as Partial<TransformBrief>;
  return `b_${createHash('sha256').update(canonical(rest)).digest('hex')}`;
}

export const parseBrief = (value: unknown): TransformBrief => { const parsed = TransformBriefSchema.parse(value) as TransformBrief; return parsed; };
export const verifyBriefId = (brief: TransformBrief): boolean => computeBriefId(brief) === brief.briefId;
export const parseSubmission = (value: unknown): Submission => SubmissionSchema.parse(value) as Submission;
export const parseApplyResult = (value: unknown): ApplyResult => ApplyResultSchema.parse(value) as ApplyResult;
