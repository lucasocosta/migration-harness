#!/usr/bin/env node
import { readFile, mkdir, open, rename, unlink, lstat } from 'node:fs/promises';
import { dirname, resolve, basename, relative, isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { parseContract, parseRawTrace, parseSanitizedTrace, parseScenario, parseManifest, HarnessPolicySchema, HttpEvidenceBundleSchema, type Invariant, type HttpEndpointInvariant } from '@migration-harness/core';
import { approveContract, reviewContract, verifyContractIntegrity } from '@migration-harness/contract-review';
import { sanitizeTrace, synthesizeContract, importOpenApi, importExistingTestEvidence, type SanitizationPolicy } from '@migration-harness/contract-synthesizer';
import { EquivalenceValidator, parseValidationPolicy } from '@migration-harness/equivalence-validator';
import { anchorAudit, ArtifactStore, AuditTrail, runRepairLoop, safeArtifactPath, withFileLock, type ArtifactStoreOptions, type AuditEntry } from '@migration-harness/engine';
import { fileHash } from '@migration-harness/llm-worker';
import { issueAssistantBrief, applyAssistantSubmission } from './assistant.js';
import { publicPath, readPublicJson, withAssistantLock } from './assistant-files.js';
import { projectChecksCommand } from './project-checks.js';
import { migrationCommand, migrationHelp } from './migration.js';

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command && ['prepare-migration', 'verify-migration', 'start-migration-session', 'migration-session-status', 'update-migration-session'].includes(command) && args.length === 1 && args[0] === '--help') {
    console.log(migrationHelp(command)); return;
  }
  if (command === 'check-projects' && args.length === 1 && args[0] === '--help') {
    console.log('check-projects --config <migration.json> --workspace-root <dir> --artifact-root <dir> --out <relative.json>\n  --preflight-only: inspect declared inputs/cwd without executing\n  --allow-project-commands: authorize declared native project checks\n  --phase baseline|candidate: default baseline; --baseline <report.json> compares candidate check outcomes\nExit codes: 0 checks passed; 4 native check failed; 5 inconclusive; 1 invalid input/output. Not behavioral equivalence.');
    return;
  }
  const stringOptions = ['input', 'out', 'source', 'target', 'contract', 'approved-by', 'scenario', 'base-url', 'artifact-root', 'unit-id', 'runs', 'key-file', 'manifest', 'source-root', 'entrypoint', 'source-url', 'target-url', 'max-repairs', 'target-file', 'retention-hours', 'policy', 'candidate-root', 'evidence', 'unit', 'plan', 'brief', 'equivalence', 'source-trace', 'candidate-files', 'context-files', 'attempt', 'next-out', 'ref-map', 'keys-root', 'backup-root', 'backup-generations', 'store-root', 'audit', 'path', 'prune-key-versions'];
  stringOptions.push('config', 'workspace-root', 'phase', 'baseline', 'artifact-path', 'preparation', 'previous', 'owner-decision');
  const { values } = parseArgs({ args, options: { ...Object.fromEntries(stringOptions.map(name => [name, { type: 'string' as const }])), repair: { type: 'boolean' as const }, encrypt: { type: 'boolean' as const }, 'allow-project-commands': { type: 'boolean' as const }, 'preflight-only': { type: 'boolean' as const }, 'allow-insecure-private-store': { type: 'boolean' as const } }, strict: true, allowPositionals: false });
  if (command === 'check-projects') { await projectChecksCommand(values); return; }
  if (command === 'prepare-migration' || command === 'verify-migration' || command === 'start-migration-session' || command === 'migration-session-status' || command === 'update-migration-session') { await migrationCommand(command, values); return; }
  const flag = (name: string): string | undefined => (values as Record<string, unknown>)[name] as string | undefined;
  const required = (name: string): string => { const value = flag(name); if (!value) throw new Error(`Required flag --${name} is missing.`); return value; };
  const number = (name: string, fallback: number, min = 0, max = 100): number => { const value = flag(name) === undefined ? fallback : Number(flag(name)); if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid --${name}.`); return value; };
  const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8')) as unknown;
  const artifactRoot = resolve(flag('artifact-root') ?? '.');
  // Operational storage options; all default OFF/unset so existing behavior stays byte-identical:
  // --encrypt seals private raw-domain writes (AES-256-GCM, versioned keyring in --keys-root),
  // --backup-root archives expired raw files during purge-raw outside the public artifact root.
  // --allow-insecure-private-store permits DEGRADED privacy when the FS cannot enforce 0700/0600 (Windows).
  const storeOptions: ArtifactStoreOptions = {
    ...(values.encrypt ? { encryptPrivate: true } : {}),
    ...(values['allow-insecure-private-store'] ? { allowInsecurePrivateStore: true } : {}),
    ...(flag('keys-root') ? { keysRoot: required('keys-root') } : {}),
    ...(flag('backup-root') ? { backup: { root: required('backup-root'), ...(flag('backup-generations') ? { keepGenerations: number('backup-generations', 5, 1, 100) } : {}) } } : {}),
  };
  const store = new ArtifactStore(artifactRoot, undefined, storeOptions);
  const loadAuditChain = async (path: string): Promise<AuditTrail> => {
    let parsed: unknown;
    try { parsed = await readPublicJson(path, store); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new AuditTrail(); throw error; }
    if (!Array.isArray(parsed)) throw new Error('Audit chain must be an array of hash-chained entries.');
    return AuditTrail.load(parsed as AuditEntry[]);
  };
  const policyConfig = HarnessPolicySchema.parse(flag('policy') ? (command === 'brief' || command === 'apply-patch' ? await readPublicJson(required('policy'), store) : await json(required('policy'))) : {});
  const sanitizationPolicy = policyConfig.sanitization as Omit<SanitizationPolicy, 'pseudonymizationKey'> | undefined;
  const validationPolicy = parseValidationPolicy(policyConfig);
  const key = async (): Promise<string> => {
    if (flag('key-file')) return (await readFile(required('key-file'), 'utf8')).trim();
    const path = await store.privatePath('pseudonymization.key');
    try { if ((await lstat(path)).mode & 0o077) throw new Error('Pseudonymization key must be private.'); return (await readFile(path, 'utf8')).trim(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const value = randomBytes(32).toString('hex');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(path, 'wx', 0o600);
    try { if ((await handle.stat()).mode & 0o077) throw new Error('Pseudonymization key filesystem must enforce mode 0600.'); await handle.writeFile(value); } finally { await handle.close(); }
    return value;
  };
  switch (command) {
    case 'sanitize-trace': await writeJson(required('out'), sanitizeTrace(parseRawTrace(await json(required('input'))), { ...sanitizationPolicy, pseudonymizationKey: await key() })); break;
    case 'review-contract': await writeJson(required('out'), reviewContract(parseContract(await json(required('input'))))); break;
    case 'approve-contract': await writeJson(required('out'), approveContract(parseContract(await json(required('input'))), required('approved-by'))); break;
    case 'verify-contract': { const valid = verifyContractIntegrity(parseContract(await json(required('contract')))); console.log(valid ? 'Contract integrity: VALID' : 'Contract integrity: INVALID'); process.exitCode = valid ? 0 : 2; break; }
    case 'compare': {
      const result = new EquivalenceValidator().validate({ source: parseSanitizedTrace(await json(required('source'))), target: parseSanitizedTrace(await json(required('target'))),
        policy: validationPolicy,
        ...(flag('contract') ? { contract: parseContract(await json(required('contract'))) } : {}), ...(flag('manifest') ? { transformationManifest: parseManifest(await json(required('manifest'))) } : {}),
      });
      if (flag('out')) await writeJson(required('out'), result);
      console.log(JSON.stringify(result, null, 2)); process.exitCode = result.status === 'EQUIVALENT' ? 0 : 4; break;
    }
    case 'discover': { const { discover } = await import('@migration-harness/static-analyzer'); const result = await discover(required('source-root'), flag('entrypoint') ? [required('entrypoint')] : undefined); await writeJson(required('out'), result); break; }
    case 'plan': { const { discover } = await import('@migration-harness/static-analyzer'); const { planTransformation } = await import('@migration-harness/transformation-planner'); const result = await discover(required('source-root'), flag('entrypoint') ? [required('entrypoint')] : undefined); await writeJson(required('out'), planTransformation(result)); break; }
    case 'trace': {
      const { captureScenario } = await import('@migration-harness/scenario-runner');
      const scenario = parseScenario(await json(required('scenario')));
      const sharedKey = await key();
      for (let runIndex = 1; runIndex <= number('runs', 1, 1); runIndex++) {
        const raw = await captureScenario(scenario, runIndex, { fixtureBaseDir: dirname(resolve(required('scenario'))), ...(policyConfig.allowedOrigins ? { allowedOrigins: policyConfig.allowedOrigins } : {}), ...(flag('base-url') ? { baseUrl: required('base-url') } : {}) });
        await store.writeRaw(scenario.unitId, raw);
        const path = await store.writeSanitized(scenario.unitId, 'source', sanitizeTrace(raw, { ...sanitizationPolicy, pseudonymizationKey: sharedKey }));
        console.log(path);
      }
      break;
    }
    case 'synthesize': {
      const paths = required('input').split(',');
      const traces = [];
      for (const path of paths) traces.push(parseSanitizedTrace(await json(path)));
      const additional: Invariant<HttpEndpointInvariant>[] = [];
      for (const path of flag('evidence')?.split(',') ?? []) {
        const bundle = HttpEvidenceBundleSchema.parse(await json(path));
        if (bundle.unresolved.length) throw new Error(`Evidence ${path} has unresolved findings requiring review.`);
        additional.push(...bundle.invariants as Invariant<HttpEndpointInvariant>[]);
      }
      await writeJson(required('out'), synthesizeContract(required('unit-id'), traces, additional)); break;
    }
    // --ref-map is an operator-provided JSON object of external-ref-prefix -> local path; the importer validates it
    // strictly (OpenApiRefMapSchema), refuses private roots and never fetches; unmapped external refs stay review findings.
    case 'import-openapi': await writeJson(required('out'), importOpenApi(await readPublicJson(required('input'), store), required('input'), { privateRoots: [store.privateRoot, store.keysRoot, ...(store.options.backup ? [store.options.backup.root] : [])], ...(flag('ref-map') ? { refMap: await readPublicJson(required('ref-map'), store) as Record<string, string> } : {}) })); break;
    case 'import-test-evidence': await writeJson(required('out'), importExistingTestEvidence(await json(required('input')), required('input'))); break;
    case 'transform': {
      const { transformAngularComponent } = await import('@migration-harness/codemods');
      const input = required('input');
      const result = transformAngularComponent(await readFile(input, 'utf8'), required('unit-id'), basename(input));
      await writeText(required('out'), result.code);
      await writeJson(required('manifest'), result.manifest); break;
    }
    case 'run': {
      const { captureScenario } = await import('@migration-harness/scenario-runner');
      const { repairHttpMethod } = await import('@migration-harness/codemods');
      const scenario = parseScenario(await json(required('scenario')));
      const contract = parseContract(await json(required('contract')));
      if (contract.unitId !== scenario.unitId) throw new Error('Scenario and contract unit mismatch.');
      const sharedKey = await key();
      // The assistant loop runs 'run' repeatedly against one artifact root; each invocation namespaces its own captures.
      const invocation = `${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
      const capture = async (baseUrl: string, index: number, side: 'source' | 'target') => {
        const raw = await captureScenario(scenario, index, { baseUrl, fixtureBaseDir: dirname(resolve(required('scenario'))), ...(policyConfig.allowedOrigins ? { allowedOrigins: policyConfig.allowedOrigins } : {}) });
        await store.writeRaw(`${scenario.unitId}-${side}-${invocation}`, raw);
        const sanitized = sanitizeTrace(raw, { ...sanitizationPolicy, pseudonymizationKey: sharedKey });
        await store.writeSanitized(`${scenario.unitId}-${invocation}`, side, sanitized);
        return sanitized;
      };
      const source = await capture(required('source-url'), 1, 'source');
      const result = await runRepairLoop({ source, contract, maxRepairAttempts: number('max-repairs', 0, 0, 10),
        policy: validationPolicy,
        ...(flag('manifest') ? { manifest: parseManifest(await json(await publicPath(required('manifest'), store))) } : {}),
        captureTarget: attempt => capture(required('target-url'), attempt + 1, 'target'),
        repair: async failure => {
          const path = resolve(required('target-file'));
          if (!/\.[jt]sx?$/.test(path) || /(^|[\\/])(?:source|contracts?|tests?|validation|policy|\.migration-private)([\\/]|\.)/i.test(path) || [required('scenario'), required('contract')].some(protectedPath => resolve(protectedPath) === path)) throw new Error('Invalid repair target.');
          const candidateRoot = resolve(required('candidate-root'));
          await safeArtifactPath(candidateRoot, relative(candidateRoot, path));
          if ((await lstat(path)).nlink !== 1) throw new Error('Repair target cannot have hard links.');
          const divergence = failure.divergences.find(d => d.code === 'NETWORK_METHOD_MISMATCH');
          if (!divergence || typeof divergence.source !== 'string' || typeof divergence.target !== 'string') throw new Error('No localized method mismatch.');
          const before = await readFile(path, 'utf8');
          const after = repairHttpMethod(before, divergence.source, divergence.target);
          await store.write(`.migration-private/repair-backups/${Date.now()}.json`, { path, before }, true);
          const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
          try {
            await writeText(temporary, after);
            if (await readFile(path, 'utf8') !== before) throw new Error('Candidate changed during repair.');
            await rename(temporary, path);
          } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
          return { changedFiles: [path], patchHash: fileHash(after) };
        },
      });
      await writeJson(required('out'), result); console.log(result.result.status); process.exitCode = result.result.status === 'EQUIVALENT' ? 0 : 4; break;
    }
    case 'purge-raw': console.log(await store.purgeRaw(number('retention-hours', 24, 0, 8760) * 3600000)); break;
    case 'rotate-raw-key': {
      const target = new ArtifactStore(resolve(required('store-root')), undefined, storeOptions);
      const auditPath = await publicPath(await publicPath(required('audit'), target), store);
      await withAssistantLock(store, target.root, () => withFileLock(`${auditPath}.lock`, async () => {
      const trail = await loadAuditChain(auditPath);
      // Fail-closed: rotateRawKey records RAW_KEY_ROTATION on the trail only after the full sweep succeeds.
      const summary = await target.rotateRawKey(trail, flag('prune-key-versions') === undefined ? undefined : number('prune-key-versions', 1, 1, 64));
      await replaceJson(auditPath, trail.snapshot());
      console.log(JSON.stringify(summary));
      })); break;
    }
    case 'anchor-audit': {
      const auditPath = await publicPath(required('audit'), store);
      const externalPath = await publicPath(required('path'), store);
      if (externalPath === auditPath) throw new Error('Audit and anchor paths must differ.');
      await withAssistantLock(store, store.root, () => withFileLock(`${auditPath}.lock`, async () => {
      const { anchor, entries } = await anchorAudit({ entries: await readPublicJson(auditPath, store), externalPath, privateRoots: [store.privateRoot] });
      await replaceJson(auditPath, entries);
      console.log(JSON.stringify(anchor));
      })); break;
    }
    case 'brief': {
      const brief = await issueAssistantBrief(values, store, policyConfig.assistant);
      console.log(brief.briefId);
      break;
    }
    case 'apply-patch': {
      const result = await applyAssistantSubmission(values, store);
      console.log(result.status);
      process.exitCode = result.status === 'PASS' ? 0 : 3;
      break;
    }
    default:
      console.log('Standard validation: prepare-migration, verify-migration, start-migration-session, update-migration-session, migration-session-status (use --help).');
      console.log('Migration Harness\nCommands: check-projects, discover, plan, trace, sanitize-trace, import-openapi, import-test-evidence, synthesize, review-contract, approve-contract, verify-contract, transform, compare, run, brief, apply-patch, purge-raw, rotate-raw-key, anchor-audit\nSee docs/USAGE.md and AGENTS.md for command arguments and the assistant protocol.');
      if (command && command !== 'help') process.exitCode = 1;
  }
}
async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  const handle = await open(path, 'wx');
  try { await handle.writeFile(value); } finally { await handle.close(); }
}
async function writeJson(path: string, value: unknown): Promise<void> { await writeText(path, `${JSON.stringify(value, null, 2)}\n`); }
/** Operator-chain files (audit.json) are extended in place: exclusive temp write, then an atomic rename. */
async function replaceJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await safeArtifactPath(dirname(path), basename(path));
  try { await writeText(temporary, `${JSON.stringify(value, null, 2)}\n`); await rename(temporary, path); }
  finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
