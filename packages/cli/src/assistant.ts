import { readFile, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, computeBriefId, parseApplyResult, parseBrief, parseContract, parseEquivalenceResult, parseMigrationUnit, parsePlan, parseSanitizedTrace, parseScenario, parseSubmission, verifyBriefId, type ApplyRefusal, type ApplyRefusalCode, type ApplyResult, type Submission, type TransformBrief } from '@migration-harness/core';
import { verifyContractIntegrity } from '@migration-harness/contract-review';
import { projectTraceForLlm } from '@migration-harness/contract-synthesizer';
import { ArtifactStore, AuditTrail, safeArtifactPath } from '@migration-harness/engine';
import { changedBytes, collectTraceValues, fileHash, screenPatchContent, validatePatches, type TraceScreen } from '@migration-harness/llm-worker';
import { classifyFailure } from '@migration-harness/quality-gates/dist/evaluate.js';
import { applyCandidateBatch, candidateFile, publicPath, readPublicJson, writePublicBatch, withAssistantLock } from './assistant-files.js';

export interface AssistantPolicy { allowedPackages: string[]; targetConventions?: Record<string, string> | undefined; maxBriefBytes?: number | undefined; maxSubmissionBytes?: number | undefined; typecheck?: boolean | undefined; lint?: boolean | undefined; }
type Flags = Record<string, string | boolean | undefined>;
interface Issuance { brief: TransformBrief; candidateRoot: string; scenarioPaths: string[]; contractPath: string; policyPath?: string; protectedFiles: Array<{ path: string; sha256: string }>; maxSubmissionBytes: number; typecheck: boolean; lint: boolean; }
const required = (flags: Flags, key: string): string => { const value = flags[key]; if (typeof value !== 'string' || !value) throw new Error(`Required flag --${key} is missing.`); return value; };
const option = (flags: Flags, key: string, fallback: string): string => typeof flags[key] === 'string' ? flags[key] as string : fallback;
const quote = (value: string): string => /^[\w./:-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

function outputPath(store: ArtifactStore, flags: Flags): string {
  const path = relative(resolve(store.root), resolve(store.root, required(flags, 'out'))).replace(/\\/g, '/');
  if (!path || path.startsWith('..') || path.startsWith('assistant/') || path.startsWith('.') || !path.endsWith('.json')) throw new Error('Assistant output must be a public JSON file outside the reserved assistant archive.');
  return path;
}
async function checkOutput(store: ArtifactStore, path: string, kinds: string[]): Promise<void> {
  const target = await publicPath(await safeArtifactPath(store.root, path), store);
  try {
    const previous = await readPublicJson(target, store) as { kind?: string };
    if (!previous || !kinds.includes(previous.kind ?? '')) throw new Error('Output would overwrite a non-assistant artifact.');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
async function audit(store: ArtifactStore): Promise<AuditTrail> {
  try { return AuditTrail.load(await readPublicJson(resolve(store.root, 'assistant/audit.json'), store) as Parameters<typeof AuditTrail.load>[0]); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new AuditTrail(); throw error; }
}
const screen = (value: unknown) => screenPatchContent([{ path: '<artifact>', beforeHash: fileHash(''), content: JSON.stringify(value) }]);
const publicPatchPath = (path: string): string => screen(path).length ? '<redacted-path>' : path;

export async function issueAssistantBrief(flags: Flags, store: ArtifactStore, policy: AssistantPolicy | undefined): Promise<TransformBrief> {
  if (!policy) throw new Error('Policy must declare an assistant section before briefs can be issued.');
  const candidateRoot = await publicPath(resolve(option(flags, 'candidate-root', '.')), store);
  return withAssistantLock(store, candidateRoot, async () => {
    const input = (key: string) => readPublicJson(required(flags, key), store);
    const rawUnit = await input('unit');
    const unit = parseMigrationUnit((rawUnit as { unit?: unknown }).unit ?? rawUnit);
    const unitId = required(flags, 'unit-id');
    const plan = parsePlan(await input('plan'));
    const contract = parseContract(await input('contract'));
    if (unit.id !== unitId || plan.unitId !== unitId || contract.unitId !== unitId) throw new Error('Brief unitId mismatch.');
    if (!verifyContractIntegrity(contract)) throw new Error('Brief contract must be APPROVED and pass integrity verification.');
    const scenarioPaths = required(flags, 'scenario').split(',');
    const scenarios = [];
    for (const path of scenarioPaths) {
      const scenario = parseScenario(await readPublicJson(path, store));
      if (scenario.unitId !== unitId) throw new Error('Brief scenario unitId mismatch.');
      scenarios.push({ scenarioId: scenario.scenarioId, name: scenario.name, description: scenario.description, testDataProfile: scenario.testDataProfile });
    }
    const sourceTrace = await input('source-trace');
    let sanitized;
    try { sanitized = parseSanitizedTrace(sourceTrace); } catch { throw new Error('Brief requires a sanitized source trace.'); }
    if (!scenarios.some(item => item.scenarioId === sanitized.scenarioId)) throw new Error('Source trace scenario is outside this brief.');
    const sourceRoot = resolve(option(flags, 'source-root', '.'));
    const sourceFiles = unit.symbols.map(symbol => resolve(sourceRoot, symbol.filePath));
    const extras = option(flags, 'context-files', '').split(',').filter(Boolean).map(path => resolve(path));
    const contextFiles = [...new Set([...sourceFiles, ...extras])].sort();
    for (const path of contextFiles) {
      const inside = (root: string): boolean => { const rel = relative(root, path); return !!rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'); };
      const root = inside(sourceRoot) ? sourceRoot : inside(candidateRoot) ? candidateRoot : undefined;
      if (!root || !/\.(?:tsx?|json|html|css|scss|md)$/.test(path)) throw new Error('Context files must be explicit source/text files inside source or candidate roots.');
      await publicPath(await safeArtifactPath(root, relative(root, path)), store);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Context file must be an unlinked regular file.');
    }
    const protectedPaths = [...new Set([required(flags, 'unit'), required(flags, 'plan'), required(flags, 'contract'), required(flags, 'source-trace'), ...scenarioPaths, ...(flags.policy ? [required(flags, 'policy')] : []), ...contextFiles, resolve('AGENTS.md')])];
    const protectedFiles = [];
    for (const path of protectedPaths) {
      await publicPath(path, store);
      const content = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT' && path === resolve('AGENTS.md')) return undefined; throw error; });
      if (content !== undefined) protectedFiles.push({ path: resolve(path), sha256: fileHash(content) });
    }
    const paths = required(flags, 'candidate-files').split(',');
    const allowedFiles = [];
    for (const path of paths) {
      const file = await candidateFile(candidateRoot, path, paths, store);
      if (protectedFiles.some(protectedFile => protectedFile.path === file.target)) throw new Error('Candidate file overlaps a protected input.');
      allowedFiles.push({ path, sha256: fileHash(file.content ?? ''), exists: file.content !== undefined });
    }
    let repair: TransformBrief['repair'];
    if (flags.repair === true) {
      const envelope = await input('equivalence') as { result?: unknown };
      const result = parseEquivalenceResult(envelope.result ?? envelope);
      if (!scenarios.some(scenario => scenario.scenarioId === result.scenarioId)) throw new Error('Repair failure belongs to another scenario.');
      if (classifyFailure(result) !== 'AUTO_REPAIRABLE' || result.status !== 'NOT_EQUIVALENT') throw new Error('Repair brief refused: only AUTO_REPAIRABLE failures may enter repair.');
      const failure = result.divergences.find(item => item.scenarioId === result.scenarioId && item.code === 'NETWORK_METHOD_MISMATCH' && item.severity === 'BLOCKING');
      if (!failure || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(failure.source)) || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(failure.target))) throw new Error('Repair requires localized HTTP methods.');
      repair = { failure: { code: failure.code, dimension: failure.dimension, message: 'Observed HTTP method differs from the source operation.', source: failure.source, target: failure.target }, editBudgetBytes: 4096, attempt: Number(option(flags, 'attempt', '1')), maxAttempts: Number(option(flags, 'max-repairs', '10')) };
    }
    const out = outputPath(store, flags);
    await checkOutput(store, out, ['TRANSFORM_BRIEF', 'REPAIR_BRIEF']);
    if ([...protectedFiles.map(file => file.path), ...paths.map(path => resolve(candidateRoot, path))].includes(resolve(store.root, out))) throw new Error('Brief output overlaps protected or candidate files.');
    const draft = { kind: repair ? 'REPAIR_BRIEF' as const : 'TRANSFORM_BRIEF' as const, briefVersion: '1' as const, unitId, generatedAt: new Date().toISOString(), task: repair ? 'REPAIR' as const : 'TRANSFORM' as const, plan, unit, contract, scenarios, trace: projectTraceForLlm(sanitized), allowedFiles, contextFiles, allowedPackages: policy.allowedPackages,
      ...(policy.targetConventions ? { targetConventions: policy.targetConventions } : {}),
      submission: { format: { patches: 'JSON array of {path,beforeHash,content}; TypeScript replacements inside allowedFiles only.', manifest: 'TransformationManifest matching unitId; claims are hints, never authority.', instructions: 'Follow AGENTS.md. Read only contextFiles/allowedFiles; submit patches for independent harness verification.' }, command: `apply-patch --brief ${quote(resolve(store.root, out))} --candidate-root ${quote(candidateRoot)} --artifact-root ${quote(resolve(store.root))} --input <submission.json> --out <apply-result.json>` }, ...(repair ? { repair } : {}),
    };
    const brief = parseBrief({ ...draft, briefId: computeBriefId(draft) });
    if (screen(brief).length) throw new Error('Brief contains forbidden trace tokens or private-domain references; review its critical inputs without modifying an approved contract in place.');
    if (Buffer.byteLength(`${JSON.stringify(brief, null, 2)}\n`) > (policy.maxBriefBytes ?? 262144)) throw new Error('Brief exceeds the assistant brief budget.');
    const issuance: Issuance = { brief, candidateRoot, scenarioPaths: scenarioPaths.map(path => resolve(path)), contractPath: resolve(required(flags, 'contract')), ...(flags.policy ? { policyPath: resolve(required(flags, 'policy')) } : {}), protectedFiles, maxSubmissionBytes: policy.maxSubmissionBytes ?? 2_000_000, typecheck: policy.typecheck ?? false, lint: policy.lint ?? false };
    const trail = await audit(store);
    trail.record('BRIEF_ISSUED', { briefId: brief.briefId, kind: brief.kind, unitId });
    await writePublicBatch(store, [
      { path: `assistant/issued/${brief.briefId}.json`, value: issuance },
      { path: `assistant/briefs/${brief.briefId}.json`, value: brief },
      { path: out, value: brief, replace: true },
      { path: 'assistant/audit.json', value: trail.snapshot(), replace: true },
    ]);
    return brief;
  });
}

function workerCode(message: string): ApplyRefusalCode {
  if (/candidate boundary/.test(message)) return 'PATCH_PATH_OUTSIDE_BOUNDARY';
  if (/baseline/.test(message)) return 'BASELINE_HASH_MISMATCH';
  if (/edit budget/.test(message)) return 'EDIT_BUDGET_EXCEEDED';
  if (/Package is not allowed|Relative import escapes/.test(message)) return 'IMPORT_NOT_ALLOWED';
  if (/file count/.test(message)) return 'SCHEMA_INVALID';
  return 'AST_FORBIDDEN_CONSTRUCT';
}

export async function applyAssistantSubmission(flags: Flags, store: ArtifactStore): Promise<ApplyResult> {
  const candidateRoot = await publicPath(resolve(option(flags, 'candidate-root', '.')), store);
  const briefPath = await publicPath(required(flags, 'brief'), store), submissionPath = await publicPath(required(flags, 'input'), store);
  const out = outputPath(store, flags);
  return withAssistantLock(store, candidateRoot, async () => {
    await checkOutput(store, out, ['APPLY_RESULT']);
    if ([briefPath, submissionPath].includes(resolve(store.root, out))) throw new Error('Apply output overlaps an input.');
    const refusals: ApplyRefusal[] = [];
    const fail = (code: ApplyRefusalCode, message: string, path?: string) => refusals.push({ code, message, ...(path ? { path: publicPatchPath(path) } : {}) });
    const trail = await audit(store);
    let brief: TransformBrief | undefined, issued: Issuance | undefined, submission: Submission | undefined;
    const implementationTexts: string[] = [];
    let trace: TraceScreen | undefined = undefined;
    let briefId = 'brief-unreadable';
    try {
      const parsed = parseBrief(await readPublicJson(briefPath, store)); briefId = parsed.briefId;
      if (!verifyBriefId(parsed)) fail('BRIEF_ID_MISMATCH', 'Brief content no longer matches its hash.');
      else {
        try {
          const record = await readPublicJson(resolve(store.root, `assistant/issued/${parsed.briefId}.json`), store, 10_000_000) as Issuance;
          if (canonical(record.brief) !== canonical(parsed) || !verifyContractIntegrity(parsed.contract)) throw new Error('Invalid issuance');
          issued = record; brief = parsed;
        } catch { fail('BRIEF_ID_MISMATCH', 'No matching harness-issued brief exists in this artifact root.'); }
      }
    } catch { fail('SCHEMA_INVALID', 'Brief failed schema validation.'); }
    if (brief && issued) {
      if (issued.candidateRoot !== candidateRoot) fail('PATCH_PATH_OUTSIDE_BOUNDARY', 'Candidate root differs from the issued boundary.');
      if ([briefPath, submissionPath, ...issued.protectedFiles.map(file => file.path), ...brief.allowedFiles.map(file => resolve(candidateRoot, file.path))].includes(resolve(store.root, out))) throw new Error('Apply output overlaps protected or candidate files.');
      const entries: Array<{ path: string; content: string }> = [];
      for (const file of issued.protectedFiles) {
        try { await publicPath(file.path, store); const content = await readFile(file.path, 'utf8'); if (fileHash(content) !== file.sha256) throw new Error('Changed'); entries.push({ path: resolve(file.path), content }); }
        catch { fail('BASELINE_HASH_MISMATCH', 'A protected input changed after brief issuance.'); break; }
      }
      // Leak screening compares against the sanitized source trace harness-side; its value set never enters the assistant-facing brief.
      let sourceTrace: { path: string; value: unknown } | undefined;
      for (const entry of entries) {
        try { const value = parseSanitizedTrace(JSON.parse(entry.content)); if (!sourceTrace) sourceTrace = { path: entry.path, value }; }
        catch { /* only the sanitized source trace parses as one */ }
      }
      trace = collectTraceValues(sourceTrace?.value);
      // Exemptions come only from authorized implementation/context files plus candidate baselines. Evaluation inputs
      // (contract, scenarios, policy) and the trace itself never confer permission, whatever else lists them.
      const contextPaths = new Set(brief.contextFiles.map(path => resolve(path)));
      const evaluationPaths = new Set([resolve(issued.contractPath), ...issued.scenarioPaths.map(path => resolve(path)), ...(issued.policyPath ? [resolve(issued.policyPath)] : [])]);
      for (const entry of entries) if (entry.path !== sourceTrace?.path && contextPaths.has(entry.path) && !evaluationPaths.has(entry.path)) implementationTexts.push(entry.content);
      try { submission = parseSubmission(await readPublicJson(submissionPath, store, issued.maxSubmissionBytes)); }
      catch { fail('SCHEMA_INVALID', 'Submission failed schema validation or exceeded its size cap.'); }
    }
    const files: Record<string, string> = {};
    if (brief && submission && issued) {
      if (submission.briefId !== brief.briefId) fail('BRIEF_ID_MISMATCH', 'Submission is bound to another brief.');
      if (submission.manifest.unitId !== brief.unitId) fail('MANIFEST_UNIT_MISMATCH', 'Manifest belongs to another unit.');
      if (new Set(submission.patches.map(patch => patch.path)).size !== submission.patches.length) fail('SCHEMA_INVALID', 'Duplicate patch paths.');
      for (const allowed of brief.allowedFiles) {
        try {
          const file = await candidateFile(candidateRoot, allowed.path, brief.allowedFiles.map(file => file.path), store);
          if (fileHash(file.content ?? '') !== allowed.sha256 || (file.content !== undefined) !== allowed.exists) fail('BASELINE_HASH_MISMATCH', 'Candidate no longer matches the brief-time baseline.', allowed.path);
          if (file.content !== undefined) files[allowed.path] = file.content;
        } catch { fail('PATCH_PATH_OUTSIDE_BOUNDARY', 'Candidate path is not a safe regular file.', allowed.path); }
      }
      for (const patch of submission.patches) {
        const allowedImportFiles = brief.contextFiles.map(path => relative(candidateRoot, path).replace(/\\/g, '/')).filter(path => path && !isAbsolute(path) && path !== '..' && !path.startsWith('../'));
        try { validatePatches([patch], files, { allowedFiles: brief.allowedFiles.map(file => file.path), allowedImportFiles, allowedPackages: brief.allowedPackages, maxFiles: brief.allowedFiles.length, maxInputBytes: 1, maxOutputBytes: issued.maxSubmissionBytes, timeoutMs: 1 }, brief.task === 'REPAIR'); }
        catch (error) { const code = workerCode((error as Error).message); fail(code, `Candidate rejected by ${code}.`, patch.path); }
      }
      if (brief.repair && submission.patches.reduce((sum, patch) => sum + changedBytes(files[patch.path] ?? '', patch.content), 0) > brief.repair.editBudgetBytes) fail('EDIT_BUDGET_EXCEEDED', 'The entire repair exceeds its edit budget.');
      const screenOptions = { trace, baselineTexts: [...implementationTexts, ...Object.values(files)] };
      for (const item of [...screenPatchContent(submission.patches, screenOptions), ...screen(submission.manifest)]) fail(item.code, item.message, item.path);
      if (!refusals.length && (issued.typecheck || issued.lint)) {
        const overlay = { ...files, ...Object.fromEntries(submission.patches.map(patch => [patch.path, patch.content])) };
        if (issued.typecheck) { const { checkTypeScript } = await import('@migration-harness/quality-gates/dist/typescript/index.js'); if (!checkTypeScript(overlay, candidateRoot).passed) fail('SCHEMA_INVALID', 'Candidate failed the configured TypeScript gate.'); }
        if (issued.lint) { const { lintCandidate } = await import('@migration-harness/quality-gates/dist/eslint/index.js'); if (!(await lintCandidate(overlay)).passed) fail('AST_FORBIDDEN_CONSTRUCT', 'Candidate failed the configured lint gate.'); }
      }
    }
    const stamp = randomUUID();
    const manifestArtifact = `assistant/manifests/${briefId}-${stamp}.json`;
    const makeResult = () => parseApplyResult({ kind: 'APPLY_RESULT', briefId, unitId: brief?.unitId ?? '', status: refusals.length ? 'REFUSED' : 'PASS', refusals, appliedFiles: refusals.length ? [] : submission!.patches.map(patch => patch.path),
      ...(!refusals.length ? { next: { command: ['run', '--scenario', quote(issued!.scenarioPaths[0]!), '--contract', quote(issued!.contractPath), '--source-url', quote(option(flags, 'source-url', '<source-url>')), '--target-url', quote(option(flags, 'target-url', '<target-url>')), '--manifest', quote(resolve(store.root, manifestArtifact)), '--artifact-root', quote(resolve(store.root)), ...(issued!.policyPath ? ['--policy', quote(issued!.policyPath)] : []), '--max-repairs', '0', '--out', quote(option(flags, 'next-out', '<equivalence-result.json>'))].join(' ') } } : {}) });
    const persist = async (result: ApplyResult): Promise<void> => {
      const path = `assistant/results/${briefId}-${stamp}.apply.json`;
      trail.record(result.status === 'PASS' ? 'APPLY_PASS' : 'APPLY_REFUSED', { briefId, refusalCodes: refusals.map(item => item.code), appliedFiles: result.appliedFiles, resultArtifact: path });
      await writePublicBatch(store, [
        ...(result.status === 'PASS' ? [
          { path: `assistant/submissions/${briefId}-${stamp}.json`, value: submission },
          { path: manifestArtifact, value: submission!.manifest },
        ] : [{ path: `assistant/refusals/${briefId}-${stamp}.json`, value: { briefId, refusals, patchHashes: submission?.patches.map(patch => ({ path: publicPatchPath(patch.path), beforeHash: patch.beforeHash, contentHash: fileHash(patch.content) })) ?? [] } }]),
        { path, value: result },
        { path: out, value: result, replace: true },
        { path: 'assistant/audit.json', value: trail.snapshot(), replace: true },
      ]);
    };
    if (refusals.length) { const result = makeResult(); await persist(result); return result; }
    const result = makeResult();
    await applyCandidateBatch(candidateRoot, submission!.patches, store, () => persist(result));
    return result;
  });
}
