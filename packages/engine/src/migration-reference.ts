import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  canonical, classifyReferenceChange, MAX_REFERENCE_INPUT_BYTES, migrationConfigHash, migrationReferenceHash,
  MigrationPathSchema, parseContract, parseMigrationConfig, parseMigrationReference, ReferenceContentSchema,
  ReferenceVerificationSchema, scenarioBindingProjection, scenarioSemanticProjection, SourceObservationsSchema,
  type MigrationConfig, type MigrationReference, type ReferenceContent, type ReferenceFinding,
  type ReferenceVerification, type StateCapture, type StateDivergence,
} from '@migration-harness/core';
import { computeContractHash } from '@migration-harness/contract-review';
import { probeCommandFor, stateCapturesOf } from './state-capture.js';

const MAX_INVENTORY_FILES = 20000;
type FileFingerprint = ReferenceContent['source']['files'][number];
type ConfiguredScenario = MigrationConfig['scenarios'][number];
type Attempt = { fingerprint: FileFingerprint } | { failure: 'MISSING' | 'UNREADABLE' };

const digestOf = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

/** Raised instead of silently recording a weakened reference version; the owner must decide. */
export class ReferenceWeakeningError extends Error {
  constructor(readonly deltaKinds: string[]) {
    super(`A new reference version would weaken evaluation criteria (${deltaKinds.join(', ')}); an owner decision is required.`);
    this.name = 'ReferenceWeakeningError';
  }
}

async function resolveRoot(workspaceRoot: string, root?: string): Promise<string> {
  const base = resolve(workspaceRoot, root ?? '.');
  if ((await lstat(base)).isSymbolicLink()) throw new Error(`Reference root must not be a symlink: ${root ?? '.'}`);
  if (!(await lstat(base)).isDirectory()) throw new Error(`Reference root must be a directory: ${root ?? '.'}`);
  return base;
}

/** Lexical + filesystem guard for one evaluation input: inside the root, no symlink segment, regular file. */
async function resolveInput(base: string, relativePath: string): Promise<string> {
  if (!MigrationPathSchema.safeParse(relativePath).success) throw new Error(`Unsafe reference input path: ${relativePath}`);
  const target = resolve(base, relativePath), rel = relative(base, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Reference input escapes its root: ${relativePath}`);
  let current = base;
  for (const part of rel.split(/[\\/]/)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`Reference inputs cannot contain symlinks: ${relativePath}`);
  }
  return target;
}

async function fingerprintFile(base: string, relativePath: string): Promise<FileFingerprint> {
  const target = await resolveInput(base, relativePath);
  const stat = await lstat(target);
  if (!stat.isFile()) throw new Error(`Reference input is not a regular file: ${relativePath}`);
  if (stat.size > MAX_REFERENCE_INPUT_BYTES) throw new Error(`Reference input exceeds the input size cap: ${relativePath}`);
  const bytes = await readFile(target);
  return { path: relativePath, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength };
}

/** Verification variant: an unreadable or missing input becomes a finding instead of aborting the check. */
async function attemptFingerprint(base: string, relativePath: string): Promise<Attempt> {
  try {
    return { fingerprint: await fingerprintFile(base, relativePath) };
  } catch (error) {
    return { failure: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'MISSING' : 'UNREADABLE' };
  }
}

const sorted = (files: FileFingerprint[]): FileFingerprint[] => [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const fingerprintAll = async (base: string, paths: readonly string[]): Promise<FileFingerprint[]> =>
  sorted(await Promise.all(paths.map(path => fingerprintFile(base, path))));

/** Recursive inventory of a declared subtree. Refuses symlinks, unsupported entries and private/ignored names. */
async function walkFiles(base: string, prefix: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (relativeDir: string): Promise<void> => {
    const directory = relativeDir ? await resolveInput(base, relativeDir) : base;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Reference inputs cannot contain symlinks: ${relativePath}`);
      if (!MigrationPathSchema.safeParse(relativePath).success) throw new Error(`Unsafe reference input path: ${relativePath}`);
      if (entry.isDirectory()) await visit(relativePath);
      else if (!entry.isFile()) throw new Error(`Unsupported reference input: ${relativePath}`);
      else if (found.push(relativePath) > MAX_INVENTORY_FILES) throw new Error('Reference inventory exceeds the file cap.');
    }
  };
  await visit(prefix);
  return found.sort();
}

async function subtreePaths(base: string, path: string): Promise<string[]> {
  const target = await resolveInput(base, path);
  return (await lstat(target)).isDirectory() ? walkFiles(base, path) : [path];
}

/**
 * Best-effort revision metadata read straight from `<root>/.git` (HEAD, loose ref, packed-refs). Declared
 * evaluation-input paths never contain `.git`; this is a deliberate read-only exception for provenance
 * labeling, and any unresolved case is reported as `UNVERSIONED` rather than guessed.
 */
async function revisionOf(base: string): Promise<string> {
  const gitRoot = join(base, '.git');
  if (!(await lstat(gitRoot).then(stat => stat.isDirectory(), () => false))) return 'UNVERSIONED';
  const read = async (path: string): Promise<string> => readFile(join(gitRoot, path), 'utf8').then(value => value.trim(), () => '');
  const head = await read('HEAD');
  if (/^[a-f0-9]{40}$/.test(head)) return head;
  const ref = head.startsWith('ref: ') ? head.slice(5).trim() : '';
  if (!/^refs\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(ref) || ref.split('/').includes('..')) return 'UNVERSIONED';
  const loose = await read(ref);
  if (/^[a-f0-9]{40}$/.test(loose)) return loose;
  for (const line of (await read('packed-refs')).split('\n')) {
    const match = /^([a-f0-9]{40}) (.+)$/.exec(line.trim());
    if (match && match[2] === ref) return match[1]!;
  }
  return 'UNVERSIONED';
}

/**
 * A capture joins the criteria digest with the probe commands it resolves on each side: argv, cwd and
 * timeout of a probe are protected evaluation inputs, so changing one after reference creation is a
 * criteria change the owner has to decide, never a silent configuration edit.
 */
function captureCriteria(config: MigrationConfig, capture: StateCapture): unknown {
  const command = (side: 'source' | 'target'): unknown => {
    const probe = probeCommandFor(config, side, capture.bindings[side].commandId);
    return { id: probe.id, kind: probe.kind, argv: probe.argv, cwd: probe.cwd, timeoutMs: probe.timeoutMs };
  };
  return {
    id: capture.id, projectionId: capture.projectionId, checkpoint: capture.checkpoint, required: capture.required,
    bindings: { source: command('source'), target: command('target') },
    ...(capture.settle ? { settle: capture.settle } : {}),
  };
}

/**
 * The declared state vocabulary of one scenario, folded into its digest only when declared: the whole
 * `stateProjections` table (a projection config is an evaluation input wherever it is referenced) plus
 * this scenario's captures with their resolved probes. Configurations without state fields take the
 * historical `semanticHash` bytes exactly, mirroring how `responseClaim` joins a requirement digest.
 */
function stateCriteria(config: MigrationConfig, scenarioId: string): unknown | undefined {
  const projections = config.stateProjections ?? [];
  const captures = stateCapturesOf(config, scenarioId);
  if (!projections.length && !captures.length) return undefined;
  return {
    ...(projections.length ? { stateProjections: projections } : {}),
    ...(captures.length ? { stateCaptures: captures.map(capture => captureCriteria(config, capture)) } : {}),
  };
}

const semanticHashOf = (config: MigrationConfig, scenario: ConfiguredScenario): string => {
  const state = stateCriteria(config, scenario.definition.scenarioId);
  return state ? digestOf({ semantic: scenarioSemanticProjection(scenario.definition), state })
    : digestOf(scenarioSemanticProjection(scenario.definition));
};

/**
 * Criteria identity of an accepted state divergence: it declares no network id, so the id is derived
 * from where it is tolerated (scenario, capture, path) and never from its resolution — re-deciding the
 * same location is then a change of that criterion, not a replacement of it.
 */
const stateDifferenceId = (item: StateDivergence): string =>
  `state-${digestOf({ scenarioId: item.scenarioId, captureId: item.captureId, path: item.path }).slice(0, 40)}`;

/** Effective per-side entry URL, locators and unit scope, the only part an integration adaptation changes. */
const bindingHashOf = (scenario: ConfiguredScenario, side: 'source' | 'target'): string => digestOf(scenarioBindingProjection(scenario, side));

function criteriaWithoutFixtures(config: MigrationConfig, contract?: ReferenceContent['criteria']['criticalContract']): unknown {
  return {
    scenarios: config.scenarios.map(scenario => ({
      scenarioId: scenario.definition.scenarioId, required: scenario.required,
      semanticHash: semanticHashOf(config, scenario),
      bindings: { source: bindingHashOf(scenario, 'source'), target: bindingHashOf(scenario, 'target') },
    })),
    requirements: config.requirements.map(item => ({
      id: item.id, scenarioId: item.scenarioId, required: item.required,
      // The machine-checkable claim is part of the criterion: changing it is a criteria change, not a repair.
      // The API response-field claim and the domain-state claim join it too, but only when declared, so
      // configurations without either keep their historical digest.
      digest: digestOf({ description: item.description, origin: item.origin, sourceReference: item.sourceReference, assertion: item.assertion ?? null,
        ...(item.responseClaim ? { responseClaim: item.responseClaim } : {}),
        ...(item.stateClaim ? { stateClaim: item.stateClaim } : {}) }),
    })),
    acceptedDifferences: config.acceptedDifferences.map(item => {
      if ('code' in item) {
        // A STATE_DIVERGENCE entry declares no network id: its criteria identity is the tolerated
        // location, and its digest covers that location plus the owner decision (and the resolution
        // that decision covers), so re-deciding or re-scoping it is a recorded criteria change.
        return { id: stateDifferenceId(item), scenarioId: item.scenarioId,
          digest: digestOf({ captureId: item.captureId, path: item.path, resolution: item.resolution }) };
      }
      return { id: item.id, scenarioId: item.scenarioId,
        digest: digestOf({ description: item.description, decisionReference: item.decisionReference }) };
    }),
    checks: config.checks.map(item => {
      const command = config[item.side].commands.find(candidate => candidate.id === item.commandId)!;
      return {
        id: item.id, side: item.side, required: item.required,
        digest: digestOf({ side: item.side, commandId: command.id, kind: command.kind, argv: command.argv, cwd: command.cwd, timeoutMs: command.timeoutMs }),
      };
    }),
    policyHash: digestOf(config.policy),
    environmentHash: digestOf(config.source.build || config.target.build || config.profile || config.source.generatedPaths || config.target.generatedPaths
      ? { environment: config.environment, builds: { source: config.source.build ?? null, target: config.target.build ?? null },
        ...(config.profile ? { profile: config.profile } : {}),
        ...(config.source.generatedPaths || config.target.generatedPaths ? { generatedPaths: { source: config.source.generatedPaths ?? [], target: config.target.generatedPaths ?? [] } } : {}) }
      : config.environment), limitsHash: digestOf(config.limits),
    ...(contract ? { criticalContract: contract } : {}),
  };
}

async function contractFingerprint(config: MigrationConfig, workspaceRoot: string): Promise<ReferenceContent['criteria']['criticalContract']> {
  if (!config.criticalContract) return undefined;
  const fingerprint = await fingerprintFile(workspaceRoot, config.criticalContract.path);
  if (fingerprint.sha256 !== config.criticalContract.sha256) throw new Error('Configured critical contract does not match its declared digest.');
  const contract = parseContract(JSON.parse(await readFile(await resolveInput(workspaceRoot, config.criticalContract.path), 'utf8')) as unknown);
  if (contract.status !== 'APPROVED') throw new Error('A configured critical contract must be APPROVED by a human reviewer.');
  if (computeContractHash(contract) !== contract.integrity.contentHash) throw new Error('Configured critical contract failed its own integrity check.');
  return { ...fingerprint, bytes: fingerprint.bytes, contractId: contract.contractId, contractVersion: contract.version };
}

async function scenarioFixtures(config: MigrationConfig, workspaceRoot: string, scenario: ConfiguredScenario): Promise<FileFingerprint[]> {
  const declared = (scenario.definition.preconditions.mockInitialApiResponses ?? []).flatMap(mock => [mock, ...(mock.sequence ?? [])].map(response => `${scenario.fixtureRoot}/${response.fixturePath}`));
  const exists = await lstat(resolve(workspaceRoot, scenario.fixtureRoot)).then(stat => stat.isDirectory(), () => false);
  if (!exists) {
    if (declared.length) throw new Error(`Scenario ${scenario.definition.scenarioId} declares mock fixtures but its fixture root is missing.`);
    return [];
  }
  const paths = await walkFiles(workspaceRoot, scenario.fixtureRoot);
  for (const path of declared) if (!paths.includes(path)) throw new Error(`Declared mock fixture is missing: ${path}`);
  return fingerprintAll(workspaceRoot, paths);
}

async function collectContent(config: MigrationConfig, workspaceRoot: string, sourceObservations: unknown): Promise<ReferenceContent> {
  const sourceBase = await resolveRoot(workspaceRoot, config.source.root);
  const targetBase = await resolveRoot(workspaceRoot, config.target.root);
  const protectedPaths = (await Promise.all(config.target.protectedPaths.map(path => subtreePaths(targetBase, path)))).flat();
  const scenarios = await Promise.all(config.scenarios.map(async scenario => ({
    scenarioId: scenario.definition.scenarioId, required: scenario.required,
    semanticHash: semanticHashOf(config, scenario),
    bindings: { source: bindingHashOf(scenario, 'source'), target: bindingHashOf(scenario, 'target') },
    fixtures: await scenarioFixtures(config, workspaceRoot, scenario),
  })));
  const contract = await contractFingerprint(config, workspaceRoot);
  const criteria = criteriaWithoutFixtures(config, contract) as Record<string, unknown>;
  return ReferenceContentSchema.parse({
    source: { root: config.source.root, revision: await revisionOf(sourceBase), files: await fingerprintAll(sourceBase, config.source.relevantFiles) },
    target: {
      root: config.target.root, revision: await revisionOf(targetBase),
      files: await fingerprintAll(targetBase, config.target.relevantFiles),
      protectedFiles: await fingerprintAll(targetBase, protectedPaths),
    },
    criteria: { ...criteria, scenarios },
    sourceObservations: SourceObservationsSchema.parse(sourceObservations ?? { status: 'NOT_COLLECTED', runs: 0 }),
  });
}

export interface ReferenceCollectionInput {
  /** Migration configuration; every path is resolved under `workspaceRoot`. */
  config: unknown;
  workspaceRoot: string;
  createdAt?: string;
  /**
   * Repeated independent source executions, supplied by the runner. Absent evidence is recorded as
   * NOT_COLLECTED and blocks verification: stability collection is P3 work, not an assumption made here.
   */
  sourceObservations?: unknown;
  /** Previous reference when issuing a new version; its lineage and change classification are recorded. */
  previous?: unknown;
  /** Owner decision, required exactly when the new version would weaken evaluation criteria. */
  ownerDecisionReference?: string;
}

/**
 * Fingerprint the actual evaluation inputs (working-tree bytes of declared source/target files, protected
 * destination work, scenario fixtures and an optional approved critical contract) into a versioned reference.
 *
 * It reads public project files only, records hashes and never copies file contents into the artifact.
 * Hashes detect inconsistency; they are not authenticated provenance and cannot stop a same-user mutation.
 */
export async function collectMigrationReference(input: ReferenceCollectionInput): Promise<MigrationReference> {
  const config = parseMigrationConfig(input.config);
  const workspaceRoot = await realpath(resolve(input.workspaceRoot));
  const content = await collectContent(config, workspaceRoot, input.sourceObservations);
  const common = {
    kind: 'MIGRATION_REFERENCE' as const, version: '1' as const, migrationId: config.migrationId,
    createdAt: input.createdAt ?? new Date().toISOString(), configurationHash: migrationConfigHash(config), ...content,
  };
  if (input.previous === undefined) {
    if (input.ownerDecisionReference !== undefined) throw new Error('An initial reference records no owner decision.');
    return parseMigrationReference({ ...common, referenceVersion: 1, change: { classification: 'INITIAL', deltas: [] } });
  }
  const previous = parseMigrationReference(input.previous);
  if (previous.migrationId !== config.migrationId) throw new Error('Previous reference belongs to another migration.');
  const change = classifyReferenceChange(previous, content);
  if (change.classification === 'INITIAL') throw new Error('A new reference version requires at least one recorded change.');
  if (change.classification === 'WEAKENING' && input.ownerDecisionReference === undefined) {
    throw new ReferenceWeakeningError([...new Set(change.deltas.map(item => item.kind))]);
  }
  if (change.classification !== 'WEAKENING' && input.ownerDecisionReference !== undefined) {
    throw new Error('Only a weakened reference version records an owner decision.');
  }
  return parseMigrationReference({
    ...common, referenceVersion: previous.referenceVersion + 1,
    supersedes: { referenceVersion: previous.referenceVersion, referenceHash: migrationReferenceHash(previous) },
    change: { ...change, ...(input.ownerDecisionReference === undefined ? {} : { ownerDecisionReference: input.ownerDecisionReference }) },
  });
}

/**
 * Re-check a reference against the current workspace. Source inputs, scenario fixtures, protected destination
 * work, declared criteria and the optional approved contract must still match; candidate changes to declared
 * target files are expected and stay informational. Missing stability evidence keeps the outcome fail-closed.
 */
export async function verifyMigrationReference(input: { reference: unknown; config: unknown; workspaceRoot: string; verifiedAt?: string }): Promise<ReferenceVerification> {
  const reference = parseMigrationReference(input.reference);
  const config = parseMigrationConfig(input.config);
  const workspaceRoot = await realpath(resolve(input.workspaceRoot));
  const findings: ReferenceFinding[] = [];
  const add = (code: ReferenceFinding['code'], severity: ReferenceFinding['severity'], extra: Omit<ReferenceFinding, 'code' | 'severity'> = {}): void => { findings.push({ code, severity, ...extra }); };
  const configurationHash = migrationConfigHash(config);
  if (reference.migrationId !== config.migrationId || reference.configurationHash !== configurationHash) add('CONFIGURATION_MISMATCH', 'BLOCKING');
  else if (canonical(criteriaWithoutFixtures(config, reference.criteria.criticalContract))
    !== canonical({ ...reference.criteria, scenarios: reference.criteria.scenarios.map(({ fixtures, ...rest }) => rest) })) add('CONFIGURATION_MISMATCH', 'BLOCKING');

  const sourceBase = await resolveRoot(workspaceRoot, reference.source.root).catch(() => undefined);
  const targetBase = await resolveRoot(workspaceRoot, reference.target.root).catch(() => undefined);
  if (!sourceBase || !targetBase) add('UNREADABLE_INPUT', 'BLOCKING');
  for (const file of sourceBase ? reference.source.files : []) {
    const attempt = await attemptFingerprint(sourceBase!, file.path);
    if ('failure' in attempt) add(attempt.failure === 'MISSING' ? 'INPUT_MISSING' : 'UNREADABLE_INPUT', 'BLOCKING', { path: file.path });
    else if (attempt.fingerprint.sha256 !== file.sha256) add('SOURCE_INPUT_CHANGED', 'BLOCKING', { path: file.path });
  }
  // The candidate is the thing under test: its declared files are expected to differ from the baseline.
  for (const file of targetBase ? reference.target.files : []) {
    const attempt = await attemptFingerprint(targetBase!, file.path);
    if ('failure' in attempt) add(attempt.failure === 'MISSING' ? 'TARGET_INPUT_CHANGED' : 'UNREADABLE_INPUT', attempt.failure === 'MISSING' ? 'INFORMATIONAL' : 'BLOCKING', { path: file.path });
    else if (attempt.fingerprint.sha256 !== file.sha256) add('TARGET_INPUT_CHANGED', 'INFORMATIONAL', { path: file.path });
  }
  for (const file of targetBase ? reference.target.protectedFiles : []) {
    const attempt = await attemptFingerprint(targetBase!, file.path);
    if ('failure' in attempt) add(attempt.failure === 'MISSING' ? 'PROTECTED_INPUT_CHANGED' : 'UNREADABLE_INPUT', 'BLOCKING', { path: file.path });
    else if (attempt.fingerprint.sha256 !== file.sha256) add('PROTECTED_INPUT_CHANGED', 'BLOCKING', { path: file.path });
  }
  if (targetBase) {
    const recorded = new Set(reference.target.protectedFiles.map(item => item.path));
    const current = await Promise.all(config.target.protectedPaths.map(path => subtreePaths(targetBase, path).catch(() => undefined)));
    for (const paths of current) {
      if (!paths) { add('UNREADABLE_INPUT', 'BLOCKING'); continue; }
      // Newly added unrelated destination work is the owner's, not a staleness signal.
      for (const path of paths) if (!recorded.has(path)) add('PROTECTED_INPUT_ADDED', 'INFORMATIONAL', { path });
    }
  }
  for (const scenario of reference.criteria.scenarios) {
    const configured = config.scenarios.find(item => item.definition.scenarioId === scenario.scenarioId);
    if (!configured) continue;
    const recorded = new Map(scenario.fixtures.map(item => [item.path, item.sha256]));
    const paths = await walkFiles(workspaceRoot, configured.fixtureRoot).catch(() => undefined);
    if (!paths) {
      if (recorded.size) add('UNREADABLE_INPUT', 'BLOCKING', { scenarioId: scenario.scenarioId });
      continue;
    }
    for (const path of paths) if (!recorded.has(path)) add('FIXTURE_ADDED', 'BLOCKING', { scenarioId: scenario.scenarioId, path });
    for (const [path, sha256] of recorded) {
      const attempt = await attemptFingerprint(workspaceRoot, path);
      if ('failure' in attempt) add(attempt.failure === 'MISSING' ? 'INPUT_MISSING' : 'UNREADABLE_INPUT', 'BLOCKING', { scenarioId: scenario.scenarioId, path });
      else if (attempt.fingerprint.sha256 !== sha256) add('FIXTURE_CHANGED', 'BLOCKING', { scenarioId: scenario.scenarioId, path });
    }
  }

  let criticalContract: ReferenceVerification['criticalContract'] = 'ABSENT';
  let criticalContractSha256: string | undefined;
  if (config.criticalContract) {
    const attempt = await attemptFingerprint(workspaceRoot, config.criticalContract.path);
    if ('failure' in attempt) { criticalContract = 'UNREADABLE'; add('CRITICAL_CONTRACT_UNREADABLE', 'BLOCKING', { path: config.criticalContract.path }); } else {
      criticalContractSha256 = attempt.fingerprint.sha256;
      const expected = reference.criteria.criticalContract;
      if (criticalContractSha256 !== config.criticalContract.sha256 || !expected || criticalContractSha256 !== expected.sha256) {
        criticalContract = 'MISMATCH'; add('CRITICAL_CONTRACT_MISMATCH', 'BLOCKING', { path: config.criticalContract.path });
      } else {
        const contract = await readFile(await resolveInput(workspaceRoot, config.criticalContract.path), 'utf8')
          .then(value => parseContract(JSON.parse(value) as unknown), () => undefined);
        if (!contract || contract.status !== 'APPROVED' || computeContractHash(contract) !== contract.integrity.contentHash
          || contract.contractId !== expected.contractId || contract.version !== expected.contractVersion) {
          criticalContract = 'NOT_APPROVED'; add('CRITICAL_CONTRACT_NOT_APPROVED', 'BLOCKING', { path: config.criticalContract.path });
        } else criticalContract = 'VERIFIED';
      }
    }
  } else if (reference.criteria.criticalContract) add('CONFIGURATION_MISMATCH', 'BLOCKING');

  if (reference.sourceObservations.status === 'NOT_COLLECTED') add('SOURCE_OBSERVATIONS_MISSING', 'BLOCKING');
  else if (reference.sourceObservations.status === 'UNSTABLE') add('SOURCE_OBSERVATIONS_UNSTABLE', 'BLOCKING');

  const unverifiable = findings.some(item => item.severity === 'BLOCKING' && ['CONFIGURATION_MISMATCH', 'UNREADABLE_INPUT',
    'CRITICAL_CONTRACT_MISMATCH', 'CRITICAL_CONTRACT_UNREADABLE', 'CRITICAL_CONTRACT_NOT_APPROVED',
    'SOURCE_OBSERVATIONS_MISSING', 'SOURCE_OBSERVATIONS_UNSTABLE'].includes(item.code));
  return ReferenceVerificationSchema.parse({
    kind: 'REFERENCE_VERIFICATION', version: '1', migrationId: reference.migrationId,
    referenceVersion: reference.referenceVersion, referenceHash: migrationReferenceHash(reference),
    configurationHash, verifiedAt: input.verifiedAt ?? new Date().toISOString(),
    status: unverifiable ? 'UNVERIFIABLE' : findings.some(item => item.severity === 'BLOCKING') ? 'STALE' : 'VERIFIED',
    criticalContract, ...(criticalContractSha256 === undefined ? {} : { criticalContractSha256 }), findings,
  });
}
