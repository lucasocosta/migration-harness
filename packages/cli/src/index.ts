#!/usr/bin/env node
import { readFile, mkdir, open, rename, unlink, lstat } from 'node:fs/promises';
import { dirname, resolve, basename, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { parseContract, parseRawTrace, parseSanitizedTrace, parseScenario, parseManifest, HarnessPolicySchema, HttpEvidenceBundleSchema, type Invariant, type HttpEndpointInvariant } from '@migration-harness/core';
import { approveContract, reviewContract, verifyContractIntegrity } from '@migration-harness/contract-review';
import { sanitizeTrace, synthesizeContract, importOpenApi, importExistingTestEvidence, type SanitizationPolicy } from '@migration-harness/contract-synthesizer';
import { EquivalenceValidator, parseValidationPolicy } from '@migration-harness/equivalence-validator';
import { ArtifactStore, runRepairLoop, safeArtifactPath } from '@migration-harness/engine';
import { fileHash } from '@migration-harness/llm-worker';
import { issueAssistantBrief, applyAssistantSubmission } from './assistant.js';
import { publicPath, readPublicJson } from './assistant-files.js';

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const stringOptions = ['input', 'out', 'source', 'target', 'contract', 'approved-by', 'scenario', 'base-url', 'artifact-root', 'unit-id', 'runs', 'key-file', 'manifest', 'source-root', 'entrypoint', 'source-url', 'target-url', 'max-repairs', 'target-file', 'retention-hours', 'policy', 'candidate-root', 'evidence', 'unit', 'plan', 'brief', 'equivalence', 'source-trace', 'candidate-files', 'attempt', 'next-out'];
  const { values } = parseArgs({ args, options: { ...Object.fromEntries(stringOptions.map(name => [name, { type: 'string' as const }])), repair: { type: 'boolean' as const } }, strict: true, allowPositionals: false });
  const flag = (name: string): string | undefined => (values as Record<string, unknown>)[name] as string | undefined;
  const required = (name: string): string => { const value = flag(name); if (!value) throw new Error(`Required flag --${name} is missing.`); return value; };
  const number = (name: string, fallback: number, min = 0, max = 100): number => { const value = flag(name) === undefined ? fallback : Number(flag(name)); if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid --${name}.`); return value; };
  const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8')) as unknown;
  const artifactRoot = resolve(flag('artifact-root') ?? '.');
  const store = new ArtifactStore(artifactRoot);
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
    case 'import-openapi': await writeJson(required('out'), importOpenApi(await json(required('input')), required('input'))); break;
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
      console.log('Migration Harness\nCommands: discover, plan, trace, sanitize-trace, import-openapi, import-test-evidence, synthesize, review-contract, approve-contract, verify-contract, transform, compare, run, brief, apply-patch, purge-raw\nSee docs/USAGE.md and AGENTS.md for command arguments and the assistant protocol.');
      if (command && command !== 'help') process.exitCode = 1;
  }
}
async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  const handle = await open(path, 'wx');
  try { await handle.writeFile(value); } finally { await handle.close(); }
}
async function writeJson(path: string, value: unknown): Promise<void> { await writeText(path, `${JSON.stringify(value, null, 2)}\n`); }
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
