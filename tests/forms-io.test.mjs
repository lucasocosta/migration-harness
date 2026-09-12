import test from 'node:test';
import assert from 'node:assert/strict';
import esbuild from 'esbuild';
import { discover } from '../packages/static-analyzer/dist/index.js';
import { planTransformation } from '../packages/transformation-planner/dist/index.js';
import { transformAngularComponent } from '../packages/codemods/dist/index.js';
import { parseManifest } from '../packages/core/dist/index.js';

const NAMES = ['SignupComponent', 'BadgeComponent', 'AuditComponent', 'InventoryComponent', 'SearchComponent', 'PingComponent', 'DraftComponent', 'NewsletterComponent', 'CheckoutComponent', 'ReviewComponent', 'DraftOrderComponent', 'SignupService', 'TokenService'];
const id = name => `forms.ts#${name}`;
const discovery = await discover('tests/fixtures/forms-io', NAMES.map(id));
const forms = name => discovery.unit.reactiveForms.find(record => record.symbolId === id(name));

test('discovery records decorated inputs, outputs and reactive-form semantics', () => {
  const input = name => discovery.unit.inputs.find(item => item.symbolId === id('SignupComponent') && item.name === name);
  assert.equal(input('coupon').type, 'string');
  assert.equal(input('name').alias, 'customerName');
  assert.ok(!input('coupon').alias);
  assert.deepEqual(discovery.unit.inputs.filter(item => item.symbolId === id('BadgeComponent')).map(item => item.name), ['label']);
  assert.equal(discovery.unit.outputs.find(item => item.symbolId === id('SignupComponent') && item.name === 'accepted').eventType, 'string');
  assert.equal(discovery.unit.outputs.find(item => item.name === 'dismissed').eventType, 'void');
  assert.deepEqual(forms('SignupComponent').controls, ['age', 'email', 'nickname']);
  assert.deepEqual(forms('SignupComponent').validators, ['max', 'min', 'minLength', 'pattern', 'required']);
  assert.deepEqual(forms('SignupComponent').templateDirectives, ['formControlName', 'formGroup', 'ngSubmit']);
  assert.deepEqual(forms('SignupComponent').subscriptions, []);
  assert.equal(forms('SignupComponent').builderInferred, false);
  assert.equal(forms('AuditComponent').hasAsyncValidators, true);
  assert.equal(forms('InventoryComponent').hasFormArray, true);
  assert.ok(forms('InventoryComponent').templateDirectives.includes('formArrayName'));
  assert.deepEqual(forms('SearchComponent').subscriptions, [{ source: 'valueChanges', semantics: 'request-response' }]);
  assert.deepEqual(forms('PingComponent').subscriptions, [{ source: 'valueChanges', semantics: 'cancellation-sensitive' }]);
  assert.deepEqual(forms('DraftComponent').subscriptions, [{ source: 'valueChanges', semantics: 'state-stream' }]);
  assert.deepEqual(forms('NewsletterComponent').templateDirectives, ['ngModel']);
  for (const [name, classification] of [['SearchComponent', 'request-response'], ['PingComponent', 'cancellation-sensitive'], ['DraftComponent', 'state-stream']])
    assert.equal(discovery.streams.find(stream => stream.symbolId === id(name)).classification, classification);
});

test('discovery normalizes builder groups to the literal shape and records async-validator evidence', () => {
  const checkout = forms('CheckoutComponent');
  assert.equal(checkout.builderInferred, true);
  assert.deepEqual(checkout.controls, ['item']);
  assert.deepEqual(checkout.validators, ['required']);
  assert.deepEqual(checkout.asyncValidatorEvidence, []);
  const review = forms('ReviewComponent');
  assert.equal(review.builderInferred, true);
  assert.deepEqual(review.controls, ['comment', 'email']);
  assert.deepEqual(review.validators, ['minLength', 'required']);
  assert.deepEqual(review.asyncValidatorEvidence, [{ field: 'email', validators: ['uniqueEmail'], scope: 'imported' }]);
  assert.equal(review.hasAsyncValidators, true);
  const audit = forms('AuditComponent');
  assert.deepEqual(audit.asyncValidatorEvidence, [{ field: 'email', validators: ['emailExists'], scope: 'local' }]);
  assert.equal(forms('DraftOrderComponent').builderInferred, false);
  const unresolved = discovery.unit.resolutionMetrics.unresolvedSymbols;
  assert.ok(unresolved.some(item => item.requestedBy === id('DraftOrderComponent') && item.reason === 'Builder form group configuration is not statically resolvable'));
  assert.ok(unresolved.some(item => item.name === 'uniqueEmail' && item.requestedBy === id('ReviewComponent') && item.reason === 'Imported async validator requires explicit resolution'));
});

test('discovery records provider lifetimes and component-level provider scope edges', () => {
  const scope = name => discovery.unit.providerScopes.find(record => record.symbolId === id(name));
  assert.deepEqual(scope('SignupService'), { symbolId: id('SignupService'), providedIn: 'root', componentProviders: [] });
  assert.deepEqual(scope('TokenService'), { symbolId: id('TokenService'), providedIn: 'type', token: 'LegacyToken', componentProviders: [] });
  assert.deepEqual(scope('BadgeComponent'), { symbolId: id('BadgeComponent'), providedIn: 'none', componentProviders: ['SignupService'] });
  assert.ok(!scope('SignupComponent'));
  assert.ok(discovery.unit.resolutionMetrics.unresolvedSymbols.some(item => item.name === 'SignupService' && item.requestedBy === id('BadgeComponent') && item.reason === 'Component-level provider requires scope resolution'));
});

test('planner routes decorated IO, literal and builder-normalized forms to CODEMOD and refuses CODEMOD beyond the safe subset', () => {
  const plan = planTransformation(discovery);
  const mechanism = name => plan.items.find(item => item.sourceSymbol === id(name));
  assert.equal(mechanism('SignupComponent').mechanism, 'CODEMOD');
  assert.match(mechanism('SignupComponent').rationale, /forms note/i);
  assert.equal(mechanism('BadgeComponent').mechanism, 'CODEMOD');
  assert.equal(mechanism('BadgeComponent').transformationClass, 'STRUCTURE_CHANGING');
  assert.equal(mechanism('CheckoutComponent').mechanism, 'CODEMOD');
  assert.match(mechanism('CheckoutComponent').rationale, /forms note/i);
  for (const name of ['AuditComponent', 'InventoryComponent', 'DraftOrderComponent', 'PingComponent', 'DraftComponent', 'ReviewComponent']) {
    assert.equal(mechanism(name).mechanism, 'MANUAL', name);
    assert.equal(mechanism(name).transformationClass, 'BEHAVIORAL_REIMPLEMENTATION', name);
  }
  assert.match(mechanism('ReviewComponent').targetConcept, /async validators/);
  assert.match(mechanism('DraftOrderComponent').targetConcept, /without static normalization/);
  assert.equal(mechanism('SearchComponent').mechanism, 'LLM');
  assert.equal(mechanism('NewsletterComponent').mechanism, 'LLM');
});

const badgeSource = `import { Component, Input, Output, EventEmitter } from '@angular/core';
export interface Label { text: string; }
@Component({ selector: 'badge-root', standalone: true, template: '<button type="button" (click)="dismiss()">x</button><p>{{ label }}</p>' })
export class BadgeComponent {
  @Input() label: string = '';
  @Input('customerName') name: string = 'guest';
  @Output() dismissed = new EventEmitter<string>();
  dismiss(): void { this.dismissed.emit(this.label); }
}
`;

const signupSource = `import { Component, Input, Output, EventEmitter } from '@angular/core';
import { FormControl, FormGroup, Validators } from '@angular/forms';
@Component({ selector: 'signup-root', standalone: true, template: '<form [formGroup]="form" (ngSubmit)="submit()"><input formControlName="nickname"><input type="number" formControlName="age"><input type="checkbox" formControlName="terms"><input type="email" formControlName="email"><button type="submit" [disabled]="form.invalid">Join</button></form>' })
export class SignupComponent {
  @Input() coupon: string = '';
  @Output() accepted = new EventEmitter<string>();
  form = new FormGroup({
    nickname: new FormControl('', [Validators.required, Validators.minLength(3)]),
    age: new FormControl(18, [Validators.min(18), Validators.max(120)]),
    terms: new FormControl(false, Validators.required),
    email: new FormControl('', Validators.compose([Validators.required, Validators.pattern('.+@.+')])),
  });
  submit(): void { if (this.form.valid) this.accepted.emit(this.form.getRawValue().nickname); }
}
`;

test('codemod maps decorated IO to required props and callback props', () => {
  const { code, manifest } = transformAngularComponent(badgeSource, 'unit', 'badge.ts');
  assert.match(code, /export interface BadgeComponentProps \{ label: string; customerName: string; onDismissed\?: \(value: string\) => void; \}/);
  assert.match(code, /model\.label = props\.label;/);
  assert.match(code, /model\.name = props\.customerName;/);
  assert.match(code, /this\.onDismissed\?\.\(this\.label\)/);
  assert.doesNotMatch(code, /EventEmitter|@Input|@Output/);
  assert.ok(code.includes('class ComponentModel') && code.includes('return <><button'));
  parseManifest(manifest);
  const mappings = Object.fromEntries(manifest.mappings.map(mapping => [mapping.mappingId, mapping]));
  assert.equal(mappings['input-name'].target, 'component.tsx#BadgeComponentProps.customerName');
  assert.match(mappings['input-name'].rationale, /alias/);
  assert.deepEqual(mappings['output-dismissed'].preserves, ['SUCCESS_BEHAVIOR']);
});

test('codemod converts simple synchronous reactive forms into controlled state with an explicit validate()', async () => {
  const { code, manifest } = transformAngularComponent(signupSource, 'unit', 'signup.ts');
  assert.match(code, /export type SignupComponentFormValue = \{ nickname: string; age: number \| string; terms: boolean; email: string \}/);
  assert.match(code, /const \[formData, setFormData\] = useState<SignupComponentFormValue>\(\{ nickname: '', age: 18, terms: false, email: '' \}\)/);
  assert.match(code, /controlErrors\['required'\] = true/);
  assert.match(code, /actualLength < 3/);
  assert.match(code, /actual < 18/);
  assert.match(code, /actual > 120/);
  assert.match(code, /new RegExp\('\.\+@\.\+'\)/);
  assert.match(code, /disabled=\{\(model\.form\.invalid\)\}/);
  assert.match(code, /onSubmit=\{async \(event\) => \{ event\.preventDefault\(\); await \(\(model\.submit\(\)\)\)/);
  assert.match(code, /setField\("nickname", \(event\.target as HTMLInputElement\)\.value\)/);
  assert.match(code, /setField\("age", \(\(\) => \{ const raw = \(event\.target as HTMLInputElement\)\.value; return raw === '' \? raw : Number\(raw\); \}\)\(\)\)/);
  assert.match(code, /setField\("terms", \(event\.target as HTMLInputElement\)\.checked\)/);
  assert.match(code, /model\.form = buildSignupComponentForm\(formData\);/);
  parseManifest(manifest);
  const mappings = Object.fromEntries(manifest.mappings.map(mapping => [mapping.mappingId, mapping]));
  assert.match(mappings['validate-nickname'].rationale, /required; minLength\(3\)/);
  assert.match(mappings['validate-email'].rationale, /compose\(required; pattern\('\.\+@\.\+'\)\)/);
  assert.ok(mappings['validate-age'].preserves.includes('VALIDATION'));
  assert.ok(mappings['form-invalid-gating'].preserves.includes('VALIDATION'));
  // Execute the generated validator: rules must match Angular semantics field-by-field.
  const validate = await evaluateValidator(code, 'validateSignupComponentForm', 'SignupComponent');
  const base = { nickname: 'abcd', age: 18, terms: false, email: 'a@b' };
  assert.deepEqual(validate({ ...base, nickname: '' }), { nickname: { required: true } });
  assert.deepEqual(validate({ ...base, nickname: '  ' }), { nickname: { minlength: { requiredLength: 3, actualLength: 2 } } });
  assert.deepEqual(validate({ ...base, terms: false }), {}); // Angular required passes on boolean false; requiredTrue stays out of the subset.
  assert.deepEqual(validate({ ...base, age: '17' }), { age: { min: { min: 18, actual: 17 } } });
  assert.deepEqual(validate({ ...base, age: 121 }), { age: { max: { max: 120, actual: 121 } } });
  assert.deepEqual(validate({ ...base, email: 'nope' }), { email: { pattern: { requiredPattern: '.+@.+', actualValue: 'nope' } } });
  assert.deepEqual(validate({ ...base, terms: true }), {});
  const candidate = await evaluateValidator(code, 'buildSignupComponentForm', 'SignupComponent');
  const state = candidate({ nickname: '', age: 18, terms: false, email: 'a@b' });
  assert.equal(state.invalid, true);
  assert.equal(state.valid, false);
  assert.deepEqual(state.getRawValue(), { nickname: '', age: 18, terms: false, email: 'a@b' });
});

async function evaluateValidator(code, exportName, className) {
  const patched = code.replace(/^import React[^\n]*\n/m, 'const React = { useReducer: 0, useRef: 0, useState: 0 };\n');
  const output = await esbuild.transform(patched, { loader: 'tsx', format: 'esm', target: 'es2020' });
  const module = await import(`data:text/javascript,${encodeURIComponent(output.code)}#${exportName}`);
  return module[exportName];
}

const literalOrderSource = `import { Component } from '@angular/core';
import { FormControl, FormGroup, Validators } from '@angular/forms';
@Component({ selector: 'order-root', standalone: true, template: '<form [formGroup]="order" (ngSubmit)="send()"><input formControlName="item"><input type="number" formControlName="qty"><button type="submit" [disabled]="order.invalid">Send</button></form>' })
export class OrderComponent {
  order = new FormGroup({ item: new FormControl('', [Validators.required, Validators.minLength(3)]), qty: new FormControl(1, Validators.min(1)) });
  send(): void { if (this.order.valid) console.log(this.order.getRawValue().item); }
}
`;

const builderOrderSource = `import { Component, inject } from '@angular/core';
import { FormBuilder, FormControl, Validators } from '@angular/forms';
@Component({ selector: 'order-root', standalone: true, template: '<form [formGroup]="order" (ngSubmit)="send()"><input formControlName="item"><input type="number" formControlName="qty"><button type="submit" [disabled]="order.invalid">Send</button></form>' })
export class OrderComponent {
  fb = inject(FormBuilder);
  order = this.fb.group({ item: ['', [Validators.required, Validators.minLength(3)]], qty: [1, Validators.min(1)] });
  send(): void { if (this.order.valid) console.log(this.order.getRawValue().item); }
}
`;

test('codemod normalizes builder groups identically to literal groups', async () => {
  const literal = transformAngularComponent(literalOrderSource, 'unit', 'order.ts');
  const builder = transformAngularComponent(builderOrderSource, 'unit', 'order.ts');
  assert.equal(builder.code, literal.code); // Byte-identical: same controlled state, validate() and gating as the literal group.
  assert.doesNotMatch(builder.code, /FormBuilder|inject|\.group\(/);
  parseManifest(builder.manifest);
  const normalization = builder.manifest.mappings.find(mapping => mapping.mappingId === 'form-builder-normalization');
  assert.ok(normalization && /normalized statically/i.test(normalization.rationale));
  assert.ok(literal.manifest.mappings.every(mapping => mapping.mappingId !== 'form-builder-normalization'));
  const validate = await evaluateValidator(builder.code, 'validateOrderComponentForm', 'OrderComponent');
  assert.deepEqual(validate({ item: '', qty: 1 }), { item: { required: true } });
  assert.deepEqual(validate({ item: 'ab', qty: 0 }), { item: { minlength: { requiredLength: 3, actualLength: 2 } }, qty: { min: { min: 1, actual: 0 } } });
  assert.deepEqual(validate({ item: 'abc', qty: 1 }), {});
  const state = (await evaluateValidator(builder.code, 'buildOrderComponentForm', 'OrderComponent'))({ item: '', qty: 1 });
  assert.equal(state.invalid, true);
});

test('codemod refuses async validators by name, FormArrays, dynamic controls, valueChanges, ngModel mixing, non-static builder configs and non-core validators', () => {
  const withBody = (source, patch) => transformAngularComponent(source.replace('submit(): void {', `${patch}\n  submit(): void {`), 'unit', 'signup.ts');
  for (const [label, run] of [
    ['async validators', () => transformAngularComponent(signupSource.replace("terms: new FormControl(false, Validators.required),", "terms: new FormControl(false, { asyncValidators: [unique] }),"), 'unit', 'signup.ts')],
    ['FormArray', () => transformAngularComponent(signupSource.replace("terms: new FormControl(false, Validators.required),", "rows: new FormArray([]),"), 'unit', 'signup.ts')],
    ['dynamic control creation', () => withBody(signupSource, "grow(): void { this.form.addControl('extra', new FormControl('')); }")],
    ['valueChanges subscription', () => withBody(signupSource, 'watch(): void { this.form.valueChanges.subscribe(values => console.log(values)); }')],
    ['statusChanges subscription', () => withBody(signupSource, 'watch(): void { this.form.statusChanges.subscribe(values => console.log(values)); }')],
    ['template-driven ngModel mixing', () => transformAngularComponent(signupSource.replace('<input formControlName="nickname">', '<input formControlName="nickname" [(ngModel)]="nickname">'), 'unit', 'signup.ts')],
    ['non-static builder configuration', () => transformAngularComponent(builderOrderSource.replace('{ item: [\'\', [Validators.required, Validators.minLength(3)]], qty: [1, Validators.min(1)] }', '{ ...this.base, qty: [1, Validators.min(1)] }'), 'unit', 'order.ts')],
    ['builder group on unknown receiver', () => transformAngularComponent(builderOrderSource.replace('this.fb.group', 'this.other.group'), 'unit', 'order.ts')],
    ['fb.array', () => transformAngularComponent(builderOrderSource.replace("qty: [1, Validators.min(1)]", "lines: this.fb.array([])"), 'unit', 'order.ts')],
    ['fb reuse outside creation', () => transformAngularComponent(builderOrderSource.replace('send(): void', 'spare(): unknown { return this.fb; }\n  send(): void'), 'unit', 'order.ts')],
    ['non-builder inject', () => transformAngularComponent(builderOrderSource.replace('fb = inject(FormBuilder);', 'fb = inject(FormBuilder);\n  http = inject(HttpClient);'), 'unit', 'order.ts')],
    ['custom validator', () => transformAngularComponent(signupSource.replace('Validators.minLength(3)', 'uniqueNickname'), 'unit', 'signup.ts')],
    ['non-core synchronous validator', () => transformAngularComponent(signupSource.replace('Validators.minLength(3)', 'Validators.email'), 'unit', 'signup.ts')],
    ['nested form group', () => transformAngularComponent(signupSource.replace("terms: new FormControl(false, Validators.required),", "address: new FormGroup({ city: new FormControl('') }),"), 'unit', 'signup.ts')],
    ['form API beyond controlled values', () => withBody(signupSource, 'clear(): void { this.form.reset(); }')],
    ['template form API access', () => transformAngularComponent(signupSource.replace('[disabled]="form.invalid"', '[disabled]="form.controls.nickname.invalid"'), 'unit', 'signup.ts')],
    ['async FormControl argument', () => transformAngularComponent(signupSource.replace('[Validators.required, Validators.minLength(3)]', '[Validators.required], [unique]'), 'unit', 'signup.ts')],
    ['optional input', () => transformAngularComponent(badgeSource.replace("label: string = '';", "label?: string;"), 'unit', 'badge.ts')],
    ['callback name collision', () => transformAngularComponent(badgeSource.replace('dismiss(): void {', 'onDismissed?: string;\n  dismiss(): void {'), 'unit', 'badge.ts')],
  ]) assert.throws(run, /needs semantic review\./, label);
  assert.throws(() => transformAngularComponent(signupSource.replace("terms: new FormControl(false, Validators.required),", "terms: new FormControl(false, { asyncValidators: [unique] }),"), 'unit', 'signup.ts'), /Async validator 'unique' needs semantic review\./);
  assert.throws(() => transformAngularComponent(signupSource.replace('[Validators.required, Validators.minLength(3)]', '[Validators.required], [unique]'), 'unit', 'signup.ts'), /Async validator 'unique' needs semantic review\./);
  assert.throws(() => transformAngularComponent(signupSource.replace("terms: new FormControl(false, Validators.required),", "rows: new FormArray([]),"), 'unit', 'signup.ts'), /FormArray needs semantic review\./);
  assert.throws(() => withBody(signupSource, 'clear(): void { this.form.reset(); }'), /this\.form\.reset/);
});

test('codemod keeps the plain standalone-component path unchanged', () => {
  const { code, manifest } = transformAngularComponent(badgeSource.replace(/@Input\(\) label: string = '';\n  @Input\('customerName'\) name: string = 'guest';\n  @Output\(\) dismissed = new EventEmitter<string>\(\);\n/, ''), 'unit', 'badge.ts');
  assert.doesNotMatch(code, /Props|useState/);
  assert.match(code, /export function BadgeComponent\(\)/);
  assert.equal(manifest.mappings.length, 1);
});
