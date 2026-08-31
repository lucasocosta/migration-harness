import type { GateResult } from '@migration-harness/core';
export interface QualityGatePort { verify(unitId: string): Promise<GateResult>; }
