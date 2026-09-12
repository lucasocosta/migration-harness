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

export type RxjsStreamSemantics =
  | 'request-response'
  | 'event-stream'
  | 'state-stream'
  | 'cancellation-sensitive'
  | 'orchestration';

export interface ComponentInputRef {
  symbolId: string;
  name: string;
  alias?: string;
  type: string;
}

export interface ComponentOutputRef {
  symbolId: string;
  name: string;
  alias?: string;
  eventType: string;
}

export interface AsyncValidatorEvidence {
  field: string;
  validators: string[];
  /** 'local' = defined inside the analyzed unit, 'imported' = external binding (explicit unresolved edge), 'unknown' = anything else. */
  scope: 'local' | 'imported' | 'unknown';
}

export interface ReactiveFormsRef {
  symbolId: string;
  formsSymbols: string[];
  templateDirectives: string[];
  controls: string[];
  validators: string[];
  hasAsyncValidators: boolean;
  hasFormArray: boolean;
  hasDynamicControlCreation: boolean;
  subscriptions: Array<{ source: string; semantics: RxjsStreamSemantics }>;
  /** True only when every FormBuilder group in the component normalized statically to control entries. */
  builderInferred: boolean;
  asyncValidatorEvidence: AsyncValidatorEvidence[];
}

export interface ProviderScopeRef {
  symbolId: string;
  providedIn: 'root' | 'platform' | 'any' | 'type' | 'unknown' | 'none';
  token?: string;
  componentProviders: string[];
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
  inputs: ComponentInputRef[];
  outputs: ComponentOutputRef[];
  reactiveForms: ReactiveFormsRef[];
  providerScopes: ProviderScopeRef[];
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
