import { createHash } from 'node:crypto';
import type { BehaviorContract } from '@migration-harness/core';
import { parseContract, canonical } from '@migration-harness/core';
export { canonicalize } from '@migration-harness/core';

export function protectedContractContent(contract: BehaviorContract): unknown {
  return {
    unitId: contract.unitId,
    contractId: contract.contractId,
    version: contract.version,
    scenarios: contract.scenarios,
  };
}

export function computeContractHash(contract: BehaviorContract): string {
  return createHash('sha256').update(canonical(protectedContractContent(contract))).digest('hex');
}

export function verifyContractIntegrity(contract: BehaviorContract): boolean {
  contract = parseContract(contract);
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
  contract = parseContract(contract);
  if (contract.status !== 'REVIEW') throw new Error('Contract must enter REVIEW before approval.');
  if (!approvedBy.trim()) throw new Error('A human reviewer is required.');
  const approved: BehaviorContract = {
    ...structuredClone(contract),
    status: 'APPROVED',
    integrity: {
      algorithm: 'sha256',
      contentHash: '',
      approvedBy,
      approvedAt,
    },
  };
  approved.integrity.contentHash = computeContractHash(approved);
  return parseContract(approved);
}

export function reviewContract(input: BehaviorContract): BehaviorContract {
  const contract = parseContract(input);
  if (contract.status !== 'DRAFT') throw new Error('Only draft contracts can enter review.');
  return { ...structuredClone(contract), status: 'REVIEW' };
}
