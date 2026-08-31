export interface TransformWorkerPort { transform(input: unknown): Promise<{ patch: string }>; }
