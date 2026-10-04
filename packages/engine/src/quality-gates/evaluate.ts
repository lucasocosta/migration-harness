import type { EquivalenceResult, FailureDisposition } from '@migration-harness/core';

export function classifyFailure(result: EquivalenceResult): FailureDisposition {
  const blocking = result.divergences.filter(d => d.severity === 'BLOCKING');
  if (!blocking.length) return 'UNKNOWN';
  if (blocking.some(d => d.dimension === 'SECURITY' || d.code === 'CONTRACT_INTEGRITY_FAILURE')) return 'REQUIRES_SECURITY_REVIEW';
  if (blocking.some(d => d.code === 'SCENARIO_FAILED')) return 'UNKNOWN';
  if (blocking.some(d => d.code === 'NON_DETERMINISTIC_EXECUTION')) return 'NON_DETERMINISTIC';
  if (blocking.some(d => d.dimension === 'CONTRACT' && d.code !== 'CONTRACT_NETWORK_METHOD')) return 'REQUIRES_CONTRACT_REVIEW';
  if (blocking.every(d => ['NETWORK_METHOD_MISMATCH', 'CONTRACT_NETWORK_METHOD'].includes(d.code))) return 'AUTO_REPAIRABLE';
  if (blocking.some(d => d.code === 'CAUSAL_ORDER_MISMATCH')) return 'REQUIRES_ARCHITECTURAL_REVIEW';
  return 'UNKNOWN';
}
