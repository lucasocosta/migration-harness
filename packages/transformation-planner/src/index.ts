import { parsePlan, type TransformationPlan } from '@migration-harness/core';
import type { DiscoveryResult } from '@migration-harness/static-analyzer';

export function planTransformation(discovery: DiscoveryResult): TransformationPlan {
  return parsePlan({ unitId: discovery.unit.id, createdAt: new Date().toISOString(), items: discovery.unit.symbols.map(symbol => {
    const stream = discovery.streams.find(s => s.symbolId === symbol.id);
    if (stream && stream.classification !== 'request-response') return { sourceSymbol: symbol.id, targetConcept: `Preserve ${stream.classification} semantics with RxJS or a reviewed state machine`, transformationClass: 'BEHAVIORAL_REIMPLEMENTATION', mechanism: 'MANUAL', rationale: 'Cancellation and multi-event semantics require architectural review.' };
    if (symbol.kind === 'type_definition') return { sourceSymbol: symbol.id, targetConcept: 'TypeScript declaration', transformationClass: 'STRUCTURE_PRESERVING', mechanism: 'CODEMOD', rationale: 'Framework-independent declaration can be preserved.' };
    return { sourceSymbol: symbol.id, targetConcept: symbol.kind === 'service' ? 'API module or query hook' : 'React component with explicit props and local state', transformationClass: 'STRUCTURE_CHANGING', mechanism: 'LLM', rationale: 'Template, dependency lifetime and state semantics require a bounded transformation followed by differential validation.' };
  }) });
}
