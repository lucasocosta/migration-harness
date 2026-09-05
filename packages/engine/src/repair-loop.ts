import { canonical, parseContract, parseSanitizedTrace, type BehaviorContract, type SanitizedObservedTrace, type TransformationManifest, type EquivalenceResult, type FailureDisposition } from '@migration-harness/core';
import { verifyContractIntegrity } from '@migration-harness/contract-review';
import { EquivalenceValidator, type EquivalenceValidationPolicy } from '@migration-harness/equivalence-validator';
import { classifyFailure } from '@migration-harness/quality-gates';
import { AuditTrail } from './artifacts.js';

export interface RepairLoopInput {
  source: SanitizedObservedTrace;
  contract: BehaviorContract;
  manifest?: TransformationManifest;
  policy?: EquivalenceValidationPolicy;
  maxRepairAttempts: number;
  captureTarget: (attempt: number) => Promise<SanitizedObservedTrace>;
  repair: (failure: EquivalenceResult, attempt: number) => Promise<{ changedFiles: string[]; patchHash: string }>;
  audit?: AuditTrail;
}
export async function runRepairLoop(input: RepairLoopInput): Promise<{ result: EquivalenceResult; attempts: number; disposition: FailureDisposition | null; audit: ReturnType<AuditTrail['snapshot']> }> {
  if (!Number.isSafeInteger(input.maxRepairAttempts) || input.maxRepairAttempts < 0 || input.maxRepairAttempts > 10) throw new Error('Repair budget must be between 0 and 10.');
  const source = parseSanitizedTrace(structuredClone(input.source));
  const contract = parseContract(structuredClone(input.contract));
  if (!verifyContractIntegrity(contract)) throw new Error('Approved contract integrity failed.');
  const fingerprint = () => canonical([input.source, input.contract, input.policy, input.policy?.network?.pathTemplateRules?.map(rule => [rule.pattern.source, rule.pattern.flags, rule.template])]);
  const protectedBaseline = fingerprint();
  const audit = input.audit ?? new AuditTrail();
  let attempts = 0;
  while (true) {
    if (fingerprint() !== protectedBaseline) throw new Error('Protected validation inputs were modified.');
    let target: SanitizedObservedTrace;
    try { target = await input.captureTarget(attempts); }
    catch {
      const result: EquivalenceResult = { scenarioId: source.scenarioId, status: 'NOT_EQUIVALENT', evaluatedAt: new Date().toISOString(), divergences: [{ divergenceId: 'CONTRACT:SCENARIO_FAILED:0', scenarioId: source.scenarioId, dimension: 'CONTRACT', code: 'SCENARIO_FAILED', severity: 'BLOCKING', message: 'Target scenario did not complete; no equivalence can be established.' }], evidence: { sourceEventCount: source.events.length, targetEventCount: 0, evaluatedDimensions: ['CONTRACT'], transformationManifestUsedAsHint: false } };
      audit.record('SCENARIO_FAILED', { attempt: attempts, scenarioId: source.scenarioId });
      return { result, attempts, disposition: 'UNKNOWN', audit: audit.snapshot() };
    }
    const result = new EquivalenceValidator().validate({ source, target, contract, ...(input.manifest ? { transformationManifest: input.manifest } : {}), ...(input.policy ? { policy: input.policy } : {}) });
    audit.record('EQUIVALENCE_VERIFY', { attempt: attempts, status: result.status, codes: result.divergences.map(d => d.code), contractHash: contract.integrity.contentHash });
    if (fingerprint() !== protectedBaseline) throw new Error('Protected validation inputs were modified.');
    if (result.status === 'EQUIVALENT') return { result, attempts, disposition: null, audit: audit.snapshot() };
    const disposition = classifyFailure(result);
    audit.record('FAILURE_CLASSIFIED', { disposition, attempt: attempts });
    if (disposition !== 'AUTO_REPAIRABLE' || attempts >= input.maxRepairAttempts) return { result, attempts, disposition, audit: audit.snapshot() };
    attempts++;
    const patch = await input.repair(structuredClone(result), attempts);
    audit.record('REPAIR_PATCH', { attempt: attempts, ...patch });
  }
}
