export * from './typescript/index.js';
export * from './angular-template/index.js';
export * from './rxjs/index.js';
export * from './routes/index.js';
export * from './graph/index.js';

/** Week 2: adapters feed the canonical MigrationUnit. */
export interface StaticAnalyzerPort {
  discover(sourceRoot: string): Promise<unknown>;
}
