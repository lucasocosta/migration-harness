#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BehaviorContract, RawObservedTrace, SanitizedObservedTrace } from '@migration-harness/core';
import { approveContract, verifyContractIntegrity } from '@migration-harness/contract-review';
import { sanitizeTrace } from '@migration-harness/contract-synthesizer';
import { EquivalenceValidator } from '@migration-harness/equivalence-validator';

const [command, ...args] = process.argv.slice(2);
const flags = parseFlags(args);

try {
  switch (command) {
    case 'sanitize-trace': {
      const input = required(flags, 'input');
      const output = required(flags, 'out');
      const trace = JSON.parse(await readFile(input, 'utf8')) as RawObservedTrace;
      await writeJson(output, sanitizeTrace(trace));
      console.log(`Sanitized trace written to ${output}`);
      break;
    }
    case 'approve-contract': {
      const input = required(flags, 'input');
      const output = required(flags, 'out');
      const approvedBy = required(flags, 'approved-by');
      const contract = JSON.parse(await readFile(input, 'utf8')) as BehaviorContract;
      const approved = approveContract(contract, approvedBy);
      await writeJson(output, approved);
      console.log(`Approved contract written to ${output}`);
      console.log(`SHA-256: ${approved.integrity.contentHash}`);
      break;
    }
    case 'verify-contract': {
      const input = required(flags, 'contract');
      const contract = JSON.parse(await readFile(input, 'utf8')) as BehaviorContract;
      const valid = verifyContractIntegrity(contract);
      console.log(valid ? 'Contract integrity: VALID' : 'Contract integrity: INVALID');
      process.exitCode = valid ? 0 : 2;
      break;
    }
    case 'compare': {
      const sourcePath = required(flags, 'source');
      const targetPath = required(flags, 'target');
      const source = JSON.parse(await readFile(sourcePath, 'utf8')) as SanitizedObservedTrace;
      const target = JSON.parse(await readFile(targetPath, 'utf8')) as SanitizedObservedTrace;
      const validator = new EquivalenceValidator();
      const result = validator.validate({ source, target });
      if (flags.has('out')) await writeJson(flags.get('out')!, result);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.status === 'EQUIVALENT' ? 0 : 4;
      break;
    }
    case 'discover':
    case 'trace':
    case 'synthesize':
    case 'run':
      console.error(`${command} remains an extension point in v0.2.`);
      process.exitCode = 3;
      break;
    default:
      printHelp();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

function parseFlags(values: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!value?.startsWith('--')) continue;
    const next = values[i + 1];
    if (!next || next.startsWith('--')) throw new Error(`Missing value for ${value}`);
    result.set(value.slice(2), next);
    i += 1;
  }
  return result;
}

function required(flagsMap: Map<string, string>, name: string): string {
  const value = flagsMap.get(name);
  if (!value) throw new Error(`Required flag --${name} is missing.`);
  return value;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function printHelp(): void {
  console.log(`Migration Harness v0.2\n\n` +
    `Implemented:\n` +
    `  harness sanitize-trace --input raw.json --out sanitized.json\n` +
    `  harness approve-contract --input draft.json --out approved.json --approved-by engineer\n` +
    `  harness verify-contract --contract approved.json\n` +
    `  harness compare --source source.sanitized.json --target target.sanitized.json [--out result.json]\n\n` +
    `Extension points:\n` +
    `  discover | trace | synthesize | run\n`);
}
