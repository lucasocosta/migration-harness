import { createHash } from 'node:crypto';
import type { BehaviorContract } from '@migration-harness/core';

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function protectedContractContent(contract: BehaviorContract): unknown {
  return {
    unitId: contract.unitId,
    contractId: contract.contractId,
    version: contract.version,
    scenarios: contract.scenarios,
  };
}

export function computeContractHash(contract: BehaviorContract): string {
  const canonical = JSON.stringify(canonicalize(protectedContractContent(contract)));
  return createHash('sha256').update(canonical).digest('hex');
}

export function verifyContractIntegrity(contract: BehaviorContract): boolean {
  if (contract.status !== 'APPROVED') {
    throw new Error(`Contract ${contract.contractId} is not APPROVED.`);
  }
  return computeContractHash(contract) === contract.integrity.contentHash;
}

export function approveContract(
  contract: BehaviorContract,
  approvedBy: string,
  approvedAt = new Date().toISOString(),
): BehaviorContract {
  const approved: BehaviorContract = {
    ...contract,
    status: 'APPROVED',
    integrity: {
      algorithm: 'sha256',
      contentHash: '',
      approvedBy,
      approvedAt,
    },
  };
  approved.integrity.contentHash = computeContractHash(approved);
  return approved;
}
