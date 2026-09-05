import { parsePlan, type TransformationPlan } from '@migration-harness/core';
import type { DiscoveryResult } from '@migration-harness/static-analyzer';

const SIMPLE_SYNC_VALIDATORS = new Set(['required', 'min', 'max', 'pattern', 'minLength', 'maxLength', 'compose']);
const REACTIVE_FORM_SYMBOLS = new Set(['FormGroup', 'FormControl', 'FormBuilder', 'NonNullableFormBuilder', 'Validators']);
const REACTIVE_TEMPLATE_DIRECTIVES = new Set(['formGroup', 'formControlName', 'formGroupName', 'formArrayName', 'formControl']);

export function planTransformation(discovery: DiscoveryResult): TransformationPlan {
  const unit = discovery.unit;
  return parsePlan({ unitId: unit.id, createdAt: new Date().toISOString(), items: unit.symbols.map(symbol => {
    const stream = discovery.streams.find(s => s.symbolId === symbol.id);
    if (stream && stream.classification !== 'request-response') return { sourceSymbol: symbol.id, targetConcept: `Preserve ${stream.classification} semantics with RxJS or a reviewed state machine`, transformationClass: 'BEHAVIORAL_REIMPLEMENTATION', mechanism: 'MANUAL', rationale: 'Cancellation and multi-event semantics require architectural review.' };
    if (symbol.kind === 'type_definition') return { sourceSymbol: symbol.id, targetConcept: 'TypeScript declaration', transformationClass: 'STRUCTURE_PRESERVING', mechanism: 'CODEMOD', rationale: 'Framework-independent declaration can be preserved.' };
    if (symbol.kind === 'component') {
      const forms = unit.reactiveForms.find(record => record.symbolId === symbol.id);
      const hasDecoratedIo = unit.inputs.some(input => input.symbolId === symbol.id) || unit.outputs.some(output => output.symbolId === symbol.id);
      const reactive = Boolean(forms) && (forms!.formsSymbols.some(name => REACTIVE_FORM_SYMBOLS.has(name)) || forms!.templateDirectives.some(directive => REACTIVE_TEMPLATE_DIRECTIVES.has(directive)) || forms!.subscriptions.length > 0);
      if (forms && reactive) {
        const blockers = [
          forms.templateDirectives.includes('ngModel') ? 'template-driven ngModel mixed with reactive forms' : undefined,
          forms.hasAsyncValidators ? 'async validators' : undefined,
          forms.hasFormArray ? 'FormArray' : undefined,
          forms.hasDynamicControlCreation ? 'dynamically created controls' : undefined,
          forms.formsSymbols.some(name => name === 'FormBuilder' || name === 'NonNullableFormBuilder') ? 'FormBuilder-created groups' : undefined,
          forms.subscriptions.some(subscription => subscription.semantics === 'request-response') ? 'valueChanges subscriptions issuing requests' : undefined,
          forms.subscriptions.some(subscription => subscription.semantics !== 'request-response') ? `${forms.subscriptions.find(subscription => subscription.semantics !== 'request-response')!.semantics} subscriptions` : undefined,
          forms.validators.some(validator => !SIMPLE_SYNC_VALIDATORS.has(validator)) ? 'validators outside the synchronous subset' : undefined,
        ].filter(Boolean) as string[];
        if (!blockers.length) return { sourceSymbol: symbol.id, targetConcept: 'React component with controlled form state and an explicit validate() function', transformationClass: 'STRUCTURE_CHANGING', mechanism: 'CODEMOD', rationale: 'Forms note: synchronous validators map one-to-one onto generated validate() checks; invalid state mirrors the Angular gating. Decorated IO maps to props and callbacks.' };
        if (forms.subscriptions.length && forms.subscriptions.every(subscription => subscription.semantics === 'request-response')) return { sourceSymbol: symbol.id, targetConcept: `Reviewed form transformation for ${blockers.join(', ')}`, transformationClass: 'STRUCTURE_CHANGING', mechanism: 'LLM', rationale: 'Request-issuing valueChanges subscriptions require a reviewed query mapping before any code generation.' };
        return { sourceSymbol: symbol.id, targetConcept: `Manual form transformation preserving reviewed semantics (${blockers.join(', ')})`, transformationClass: 'BEHAVIORAL_REIMPLEMENTATION', mechanism: 'MANUAL', rationale: 'Blocked from CODEMOD: validation and cancellation semantics exceed the deterministic codemod subset and require architectural review.' };
      }
      if (hasDecoratedIo && !forms) return { sourceSymbol: symbol.id, targetConcept: 'React component with required props for inputs and callback props for outputs', transformationClass: 'STRUCTURE_CHANGING', mechanism: 'CODEMOD', rationale: 'Decorated inputs and outputs map deterministically to props and callbacks; no reactive-form semantics detected.' };
    }
    return { sourceSymbol: symbol.id, targetConcept: symbol.kind === 'service' ? 'API module or query hook' : 'React component with explicit props and local state', transformationClass: 'STRUCTURE_CHANGING', mechanism: 'LLM', rationale: 'Template, dependency lifetime and state semantics require a bounded transformation followed by differential validation.' };
  }) });
}
