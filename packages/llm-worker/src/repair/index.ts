export interface RepairWorkerPort { repair(input: unknown): Promise<{ patch: string }>; }
