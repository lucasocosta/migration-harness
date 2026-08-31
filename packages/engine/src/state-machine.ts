import type { FailureDisposition } from '@migration-harness/core';

export type EngineState =
  | 'IDLE'
  | 'DISCOVERY'
  | 'SCENARIO_PREPARATION'
  | 'SOURCE_TRACE_CAPTURE'
  | 'NEEDS_SCENARIOS'
  | 'CONTRACT_SYNTHESIS'
  | 'CONTRACT_REVIEW'
  | 'CONTRACT_APPROVED'
  | 'TRANSFORMATION_PLAN'
  | 'TRANSFORM'
  | 'TARGET_TRACE_CAPTURE'
  | 'EQUIVALENCE_VERIFY'
  | 'FAILURE_CLASSIFIER'
  | 'REPAIR_PATCH'
  | 'PR_READY'
  | 'ESCALATE_CONTRACT'
  | 'ESCALATE_SECURITY'
  | 'ESCALATE_ARCHITECTURE'
  | 'ESCALATE_PR';

export interface HarnessExecutionContext {
  repairAttempts: number;
  maxRepairAttempts: number;
}

export class MigrationEngineStateMachine {
  private state: EngineState = 'IDLE';
  constructor(private readonly context: HarnessExecutionContext) {}

  getState(): EngineState { return this.state; }
  getRepairAttempts(): number { return this.context.repairAttempts; }

  start(): void { this.require('IDLE'); this.state = 'DISCOVERY'; }
  discoveryCompleted(): void { this.require('DISCOVERY'); this.state = 'SCENARIO_PREPARATION'; }
  scenariosPrepared(): void { this.require('SCENARIO_PREPARATION'); this.state = 'SOURCE_TRACE_CAPTURE'; }
  sourceTraceCompleted(runCount: number): void {
    this.require('SOURCE_TRACE_CAPTURE');
    this.state = runCount >= 3 ? 'CONTRACT_SYNTHESIS' : 'NEEDS_SCENARIOS';
  }
  scenariosReady(): void { this.require('NEEDS_SCENARIOS'); this.state = 'SOURCE_TRACE_CAPTURE'; }
  synthesisCompleted(needsReview: boolean): void {
    this.require('CONTRACT_SYNTHESIS');
    this.state = needsReview ? 'CONTRACT_REVIEW' : 'CONTRACT_APPROVED';
  }
  contractApproved(): void {
    if (this.state !== 'CONTRACT_REVIEW' && this.state !== 'CONTRACT_SYNTHESIS') {
      throw new Error(`Cannot approve contract from ${this.state}`);
    }
    this.state = 'CONTRACT_APPROVED';
  }
  contractIntegrityVerified(): void { this.require('CONTRACT_APPROVED'); this.state = 'TRANSFORMATION_PLAN'; }
  transformationPlanned(): void { this.require('TRANSFORMATION_PLAN'); this.state = 'TRANSFORM'; }
  transformCompleted(): void { this.require('TRANSFORM'); this.state = 'TARGET_TRACE_CAPTURE'; }
  targetTraceCompleted(): void { this.require('TARGET_TRACE_CAPTURE'); this.state = 'EQUIVALENCE_VERIFY'; }
  equivalenceEvaluated(equivalent: boolean): void {
    this.require('EQUIVALENCE_VERIFY');
    this.state = equivalent ? 'PR_READY' : 'FAILURE_CLASSIFIER';
  }
  failureClassified(disposition: FailureDisposition): void {
    this.require('FAILURE_CLASSIFIER');
    if (disposition === 'AUTO_REPAIRABLE' && this.context.repairAttempts < this.context.maxRepairAttempts) {
      this.context.repairAttempts += 1;
      this.state = 'REPAIR_PATCH';
      return;
    }
    switch (disposition) {
      case 'REQUIRES_CONTRACT_REVIEW':
      case 'NON_DETERMINISTIC': this.state = 'ESCALATE_CONTRACT'; return;
      case 'REQUIRES_SECURITY_REVIEW': this.state = 'ESCALATE_SECURITY'; return;
      case 'REQUIRES_ARCHITECTURAL_REVIEW': this.state = 'ESCALATE_ARCHITECTURE'; return;
      default: this.state = 'ESCALATE_PR';
    }
  }
  repairPatched(): void { this.require('REPAIR_PATCH'); this.state = 'EQUIVALENCE_VERIFY'; }

  private require(expected: EngineState): void {
    if (this.state !== expected) throw new Error(`Expected state ${expected}, got ${this.state}`);
  }
}
