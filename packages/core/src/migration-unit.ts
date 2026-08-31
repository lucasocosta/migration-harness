export type SymbolKind =
  | 'component'
  | 'service'
  | 'directive'
  | 'pipe'
  | 'guard'
  | 'resolver'
  | 'module'
  | 'template_embedded_view'
  | 'type_definition';

export interface SymbolRef {
  id: string;
  name: string;
  kind: SymbolKind;
  filePath: string;
  exported: boolean;
  astHash: string;
}

export interface DependencyEdge {
  fromSymbolId: string;
  toSymbolId: string;
  relation:
    | 'imports'
    | 'injects'
    | 'renders'
    | 'applies_directive'
    | 'pipes_through'
    | 'guards'
    | 'resolves';
  isDynamic: boolean;
}

export interface StaticResolutionMetrics {
  totalSymbolsIdentified: number;
  resolvedSymbolsCount: number;
  resolutionCoverage: number;
  unresolvedSymbols: Array<{ name: string; requestedBy: string; reason: string }>;
  dynamicEdgesCount: number;
}

export interface MigrationBoundary {
  entrypoints: string[];
  internalSymbols: string[];
  externalDependencies: Array<{
    name: string;
    targetPackage: string;
    resolvedStrategy: 'keep_external' | 'polyfilled' | 'mocked_in_harness';
  }>;
}

export interface MigrationUnit {
  id: string;
  version: string;
  runtimeRoutes: string[];
  symbols: SymbolRef[];
  dependencyGraph: DependencyEdge[];
  boundary: MigrationBoundary;
  resolutionMetrics: StaticResolutionMetrics;
  metadata: {
    loc: number;
    cyclomaticComplexity: number;
    hasRxjsStreams: boolean;
    hasDynamicForms: boolean;
    templateAstComplexityScore: number;
  };
}
