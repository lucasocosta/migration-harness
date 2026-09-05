import ts from 'typescript';
import { parseTemplate } from '@angular/compiler';
import type { TransformationManifest, TransformationMapping } from '@migration-harness/core';

export interface ComponentTransformation { code: string; manifest: TransformationManifest; }

interface Validator { kind: 'required' | 'min' | 'max' | 'minLength' | 'maxLength' | 'pattern' | 'compose'; argument?: string; inner?: Validator[]; }
interface Control { name: string; initial: string; valueType: 'string' | 'number' | 'boolean'; validators: Validator[]; }
interface InputSpec { name: string; alias?: string; type: string; }
interface OutputSpec { name: string; callback: string; eventType: string; }

const CORE_IMPORTS = new Set(['Component', 'Input', 'Output', 'EventEmitter']);
const FORMS_IMPORTS = new Set(['FormGroup', 'FormControl', 'FormArray', 'FormBuilder', 'NonNullableFormBuilder', 'Validators', 'ReactiveFormsModule']);
const RESERVED_FORM_DIRECTIVES = new Set(['formGroupName', 'formArrayName', 'formControl', 'ngModel', 'ngModelGroup', 'formControlName']);
const SUPPORTED_FORM_API = new Set(['valid', 'invalid', 'value', 'getRawValue']);
const ARGUMENT_VALIDATORS = new Set(['min', 'max', 'minLength', 'maxLength', 'pattern']);
const ANGULAR_REFERENCE = /\b(?:FormGroup|FormControl|FormArray|FormBuilder|NonNullableFormBuilder|Validators|EventEmitter|NgModel|ReactiveFormsModule|inject)\b/;

const refuse: (construct: string) => never = construct => { throw new Error(`${construct} needs semantic review.`); };
const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);
const propertyKey = (name: string): string => /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
const propertyAccess = (base: string, name: string): string => /^[A-Za-z_$][\w$]*$/.test(name) ? `${base}.${name}` : `${base}[${JSON.stringify(name)}]`;
const isNumericLike = (node: ts.Expression): boolean => ts.isNumericLiteral(node) || (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand));
const isBooleanLiteral = (node: ts.Expression): boolean => node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword;
const literalType = (node: ts.Expression): 'string' | 'number' | 'boolean' => ts.isStringLiteralLike(node) ? 'string' : isNumericLike(node) ? 'number' : isBooleanLiteral(node) ? 'boolean' : refuse(`Literal type of '${node.getText()}'`);
const decoratorName = (decorator: ts.Decorator, file: ts.SourceFile): string => {
  const expression = ts.isCallExpression(decorator.expression) ? decorator.expression.expression : decorator.expression;
  return expression.getText(file);
};

/** Deliberately narrow adapter: unsupported Angular semantics require a worker/review. */
export function transformAngularComponent(source: string, unitId: string, fileName = 'component.ts'): ComponentTransformation {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const classes = file.statements.filter(ts.isClassDeclaration);
  const component = classes.find(node => (ts.getDecorators(node) ?? []).some(d => ts.isCallExpression(d.expression) && d.expression.expression.getText(file) === 'Component'));
  if (!component?.name || classes.length !== 1) throw new Error('Codemod supports one standalone component per file.');
  const className = component.name.text;
  const decorator = ts.getDecorators(component)!.find(d => ts.isCallExpression(d.expression) && d.expression.expression.getText(file) === 'Component')!;
  const call = decorator.expression as ts.CallExpression;
  const config = call.arguments[0];
  if (!config || !ts.isObjectLiteralExpression(config)) throw new Error('Component metadata must be literal.');
  const templateProperty = config.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(file) === 'template');
  if (!templateProperty || !ts.isPropertyAssignment(templateProperty) || !ts.isStringLiteralLike(templateProperty.initializer)) throw new Error('Codemod requires an inline literal template.');
  for (const property of config.properties) if (!ts.isPropertyAssignment(property) || !['selector', 'standalone', 'template'].includes(property.name.getText(file))) throw new Error('Component metadata needs semantic review.');
  if (component.heritageClauses?.length) throw new Error('Inheritance, injection and decorated members need semantic review.');
  const memberRole = new Map<ts.PropertyDeclaration, 'input' | 'output'>();
  for (const member of component.members) {
    if (ts.isConstructorDeclaration(member)) throw new Error('Inheritance, injection and decorated members need semantic review.');
    for (const memberDecorator of ts.canHaveDecorators(member) ? ts.getDecorators(member) ?? [] : []) {
      const name = decoratorName(memberDecorator, file);
      if (name !== 'Input' && name !== 'Output') throw new Error('Inheritance, injection and decorated members need semantic review.');
      if (!ts.isPropertyDeclaration(member) || !member.name || !ts.isIdentifier(member.name) || memberRole.has(member)) refuse('Decorated member that is not a unique identifier-named property');
      memberRole.set(member, name === 'Input' ? 'input' : 'output');
    }
  }
  if (component.members.some(member => member.name?.getText(file).startsWith('ng'))) throw new Error('Lifecycle hooks need semantic review.');
  const inputs: InputSpec[] = [];
  const outputs: OutputSpec[] = [];
  for (const [member, role] of memberRole) {
    if (!ts.isIdentifier(member.name)) refuse('Decorated member with a non-identifier name');
    const name = member.name.text;
    const memberDecorator = (ts.getDecorators(member) ?? [])[0]!;
    const firstArgument = ts.isCallExpression(memberDecorator.expression) ? memberDecorator.expression.arguments[0] : undefined;
    if (firstArgument && !ts.isStringLiteralLike(firstArgument)) refuse('Input or Output options object');
    const alias = firstArgument?.text;
    if (role === 'input') {
      if (member.questionToken || member.exclamationToken) refuse('Optional @Input declaration');
      const initializer = member.initializer;
      if (initializer && !ts.isStringLiteralLike(initializer) && !isNumericLike(initializer) && !isBooleanLiteral(initializer)) refuse('Non-literal @Input initializer');
      const type = member.type ? member.type.getText(file) : initializer ? literalType(initializer) : refuse('Undeclared @Input type');
      inputs.push({ name, ...(alias ? { alias } : {}), type });
    } else {
      const initializer = member.initializer;
      if (!initializer || !ts.isNewExpression(initializer) || initializer.expression.getText(file) !== 'EventEmitter') refuse('@Output member without an EventEmitter initializer');
      const typeArguments = initializer.typeArguments?.length ? initializer.typeArguments : member.type && ts.isTypeReferenceNode(member.type) ? member.type.typeArguments : undefined;
      outputs.push({ name, callback: `on${capitalize(name)}`, eventType: typeArguments?.[0]?.getText(file) ?? 'void' });
    }
  }
  const parseValidator = (node: ts.Expression): Validator => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(file) === 'Validators') {
      const kind = node.expression.name.text;
      if (kind === 'compose') { const items = node.arguments[0]; if (!items || !ts.isArrayLiteralExpression(items)) refuse('Validators.compose argument'); return { kind: 'compose', inner: items.elements.map(parseValidator) }; }
      if (!ARGUMENT_VALIDATORS.has(kind) && kind !== 'required') refuse(`Validator Validators.${kind}`);
      if (kind === 'required') return { kind: 'required' };
      const value = node.arguments[0];
      if (!value) refuse(`Validators.${kind} without an argument`);
      if (kind === 'pattern') { if (!ts.isStringLiteralLike(value) && !ts.isRegularExpressionLiteral(value)) refuse('Validators.pattern argument'); }
      else if (!isNumericLike(value)) refuse(`Validators.${kind} argument`);
      return { kind: kind as Validator['kind'], argument: value.getText(file) };
    }
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(file) === 'Validators' && node.name.text === 'required') return { kind: 'required' };
    refuse(`Validator expression '${node.getText(file)}'`);
  };
  const parseValidatorList = (node: ts.Expression): Validator[] => ts.isArrayLiteralExpression(node) ? node.elements.map(parseValidator) : [parseValidator(node)];
  const parseFormGroup = (group: ts.NewExpression): Control[] => {
    if (group.typeArguments?.length) refuse('Generic FormGroup type arguments');
    const literal = group.arguments?.[0];
    if (!literal || !ts.isObjectLiteralExpression(literal)) refuse('Non-literal FormGroup configuration');
    const controls: Control[] = [];
    for (const property of literal.properties) {
      if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) refuse('Form group property');
      const controlName = property.name.text;
      const value = property.initializer;
      if (!ts.isNewExpression(value) || value.expression.getText(file) !== 'FormControl' || value.typeArguments?.length) refuse(`Form control '${controlName}' that is not a literal FormControl`);
      const args = value.arguments ?? [];
      if (args.length > 2) refuse('Async validators passed to FormControl');
      const initial = args[0];
      if (!initial || (!ts.isStringLiteralLike(initial) && !isNumericLike(initial) && !isBooleanLiteral(initial))) refuse(`Form control '${controlName}' initial value`);
      const valueType = literalType(initial);
      controls.push({ name: controlName, initial: initial.getText(file), valueType, validators: args[1] ? parseValidatorList(args[1]) : [] });
    }
    if (!controls.length) refuse('Empty FormGroup');
    return controls;
  };
  const templateText = templateProperty.initializer.text;
  const rejectUnsupportedFormSemantics = (): void => {
    if (/\basyncValidators\b/.test(source)) refuse('Async validators');
    if (/\bFormArray\b/.test(source)) refuse('FormArray');
    if (/\.\s*(?:addControl|setControl|removeControl)\s*\(/.test(source)) refuse('Dynamically created controls');
    if (/\b(?:valueChanges|statusChanges)\b/.test(source)) refuse('valueChanges or statusChanges subscriptions');
    if (/\bngModel\b/.test(templateText)) refuse('Template-driven ngModel mixed with reactive forms');
  };
  let formField: { name: string; controls: Control[] } | undefined;
  for (const member of component.members) {
    if (!ts.isPropertyDeclaration(member) || !member.initializer || !member.name || !ts.isIdentifier(member.name) || memberRole.has(member)) continue;
    const initializer = member.initializer;
    if (ts.isNewExpression(initializer) && initializer.expression.getText(file) === 'FormGroup') {
      if (formField) refuse('Multiple FormGroup fields');
      rejectUnsupportedFormSemantics();
      formField = { name: member.name.text, controls: parseFormGroup(initializer) };
    } else if (ts.isCallExpression(initializer) && ts.isPropertyAccessExpression(initializer.expression) && initializer.expression.name.text === 'group') {
      refuse('FormBuilder-created group');
    }
  }
  if (formField) {
    const scanFormApi = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword && node.expression.name.text === formField!.name && !SUPPORTED_FORM_API.has(node.name.text)) refuse(`Form API access 'this.${formField!.name}.${node.name.text}'`);
      ts.forEachChild(node, scanFormApi);
    };
    scanFormApi(component);
  }
  const extended = inputs.length > 0 || outputs.length > 0 || Boolean(formField);
  const members = new Set(component.members.flatMap(member => member.name && ts.isIdentifier(member.name) ? [member.name.text] : []));
  for (const output of outputs) if (members.has(output.callback)) refuse(`Generated callback name '${output.callback}' colliding with a class member`);
  const expression = (value: string): string => {
    const parsed = ts.createSourceFile('expression.ts', `(${value})`, ts.ScriptTarget.Latest, true);
    const transformed = ts.transform(parsed, [context => root => {
      const visit: ts.Visitor = node => {
        if (ts.isIdentifier(node) && node.text === '$event') return ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier('event'), 'nativeEvent');
        if (formField && ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === formField.name && !SUPPORTED_FORM_API.has(node.name.text)) refuse(`Template form access '${formField.name}.${node.name.text}'`);
        if (ts.isIdentifier(node) && members.has(node.text) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) return ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier('model'), node.text);
        return ts.visitEachChild(node, visit, context);
      };
      return ts.visitNode(root, visit) as ts.SourceFile;
    }]);
    const statement = transformed.transformed[0]!.statements[0];
    if (!statement || !ts.isExpressionStatement(statement)) throw new Error('Unsupported template expression.');
    const printed = ts.createPrinter().printNode(ts.EmitHint.Expression, statement.expression, parsed);
    transformed.dispose();
    return printed;
  };
  const template = parseTemplate(templateProperty.initializer.text, fileName);
  if (template.errors?.length) throw new Error(template.errors.map(error => error.toString()).join('\n'));
  let formGroupSeen = false;
  const render = (raw: unknown): string => {
    const node = raw as { name?: string; value?: unknown; attributes?: Array<{name: string; value: string}>; inputs?: Array<{name: string; value: {source?: string}}>; outputs?: Array<{name: string; handler: {source?: string}}>; children?: unknown[]; templateAttrs?: unknown[] };
    if (node.templateAttrs || !node.name && node.children) throw new Error('Structural templates require semantic transformation.');
    if (!node.name) {
      if (typeof node.value === 'string') return `{${JSON.stringify(node.value)}}`;
      const interpolation = node.value as { ast?: { strings?: string[]; expressions?: Array<{sourceSpan?: {start: number; end: number}}> }; source?: string };
      if (interpolation?.source) {
        const parts = interpolation.source.split(/(\{\{[\s\S]*?\}\})/g);
        return parts.map(part => part.startsWith('{{') ? `{${expression(part.slice(2, -2).trim())}}` : `{${JSON.stringify(part)}}`).join('');
      }
      throw new Error('Unsupported template node.');
    }
    if (!/^[a-z][a-z0-9]*$/.test(node.name)) throw new Error('Nested components require a separate migration unit.');
    const elementName = node.name;
    for (const attribute of node.attributes ?? []) if (attribute.name === 'ngModel' || attribute.name === 'ngModelGroup') refuse('Template-driven ngModel usage');
    for (const input of node.inputs ?? []) if (RESERVED_FORM_DIRECTIVES.has(input.name)) refuse(`Form directive '${input.name}'`);
    const controlAttribute = (node.attributes ?? []).find(attribute => attribute.name === 'formControlName');
    if (controlAttribute) {
      if (!formField) refuse(`formControlName '${controlAttribute.value}' without a reactive FormGroup`);
      const control = formField.controls.find(item => item.name === controlAttribute.value);
      if (!control) refuse(`formControlName '${controlAttribute.value}' without a matching control`);
      if (!['input', 'textarea'].includes(elementName)) refuse('formControlName on a non-text element');
      if ((node.inputs ?? []).length || (node.outputs ?? []).length) refuse('form control element with additional bindings');
      if (control.valueType === 'boolean' && !(node.attributes ?? []).some(attribute => attribute.name === 'type' && attribute.value === 'checkbox')) refuse('Boolean form control without a checkbox input');
      if (control.valueType === 'number' && !(node.attributes ?? []).some(attribute => attribute.name === 'type' && attribute.value === 'number')) refuse('Number form control without type="number"');
    }
    const attributes = (node.attributes ?? []).filter(attribute => attribute.name !== 'formControlName').map(a => `${a.name === 'class' ? 'className' : a.name === 'for' ? 'htmlFor' : a.name}=${JSON.stringify(a.value)}`);
    if (controlAttribute && formField) {
      const control = formField.controls.find(item => item.name === controlAttribute.value)!;
      const reference = `model.form.value[${JSON.stringify(control.name)}]`;
      const write = control.valueType === 'boolean' ? `(event.target as HTMLInputElement).checked`
        : control.valueType === 'number' ? `(() => { const raw = (event.target as HTMLInputElement).value; return raw === '' ? raw : Number(raw); })()`
        : `(event.target as HTMLInputElement).value`;
      attributes.push(control.valueType === 'boolean' ? `checked={${reference}}` : `value={${reference}}`);
      attributes.push(`onChange={event => { setField(${JSON.stringify(control.name)}, ${write}); }}`);
    }
    for (const input of node.inputs ?? []) {
      if (input.name === 'formGroup') { if (!formField || (input.value.source ?? '').trim() !== formField.name || elementName !== 'form') refuse('formGroup binding'); formGroupSeen = true; continue; }
      if (!['value', 'hidden', 'disabled', 'checked', 'required', 'title'].includes(input.name) || !input.value.source) throw new Error('Unsupported template binding.');
      attributes.push(`${input.name}={${expression(input.value.source)}}`);
    }
    for (const output of node.outputs ?? []) {
      if (output.name === 'ngSubmit') {
        if (!formField) refuse('(ngSubmit) without a reactive form');
        if (!output.handler.source || output.handler.source.includes('$event')) refuse('(ngSubmit) handler');
        attributes.push(`onSubmit={async (event) => { event.preventDefault(); await (${expression(output.handler.source)}); refresh(); }}`);
        continue;
      }
      if (output.name === 'ngModelChange') refuse('Template-driven ngModel usage');
      const name = ({ click: 'onClick', input: 'onChange', change: 'onChange', submit: 'onSubmit' } as Record<string, string>)[output.name];
      if (!name || !output.handler.source) throw new Error('Unsupported template event.');
      attributes.push(`${name}={async (event) => { await ${expression(output.handler.source)}; refresh(); }}`);
    }
    const start = `<${elementName}${attributes.length ? ' ' + attributes.join(' ') : ''}`;
    return ['input', 'br', 'hr', 'img'].includes(elementName) ? `${start} />` : `${start}>${(node.children ?? []).map(render).join('')}</${elementName}>`;
  };
  const body = template.nodes.map(render).join('');
  if (formField && !formGroupSeen) refuse('FormGroup without a [formGroup] host binding');
  const printer = ts.createPrinter();
  const extra = file.statements.filter(node => ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)).map(node => printer.printNode(ts.EmitHint.Unspecified, node, file)).join('\n');
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      const bindings = statement.importClause?.namedBindings;
      const specifier = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : '';
      const allowed = specifier === '@angular/core' ? CORE_IMPORTS : specifier === '@angular/forms' ? FORMS_IMPORTS : undefined;
      if (!allowed || !bindings || !ts.isNamedImports(bindings) || bindings.elements.some(element => !allowed.has(element.name.text) || element.propertyName)) throw new Error('Imported dependencies require semantic transformation.');
    } else if (statement !== component && !ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) throw new Error('Top-level behavior requires semantic transformation.');
  }
  const basePreserves: TransformationMapping['preserves'] = ['HTTP_METHOD', 'HTTP_PATH', 'HTTP_PAYLOAD', 'HTTP_STATUS', 'STORAGE', 'ARIA_SEMANTICS'];
  if (!extended) {
    const model = ts.factory.updateClassDeclaration(component, undefined, ts.factory.createIdentifier('ComponentModel'), component.typeParameters, undefined, component.members);
    const code = `import React, { useReducer, useRef } from 'react';\n${extra}\n${printer.printNode(ts.EmitHint.Unspecified, model, file)}\nexport function ${className}() {\n const ref = useRef<ComponentModel | null>(null);\n if (!ref.current) ref.current = new ComponentModel();\n const model = ref.current;\n const [, refresh] = useReducer(value => value + 1, 0);\n return <>${body}</>;\n}\n`;
    return { code, manifest: { unitId, generatedAt: new Date().toISOString(), transformer: { kind: 'CODEMOD', name: 'standalone-component', version: '0.4.0' }, mappings: [{ mappingId: 'component', source: `${fileName}#${className}`, target: `component.tsx#${className}`, preserves: basePreserves, rationale: 'Preserved method bodies; adapted supported template bindings and event-driven rendering.' }] } };
  }
  const emitTargets = new Map(outputs.map(output => [output.name, output.callback]));
  const transformEmits = (): ts.ClassElement[] => {
    if (!emitTargets.size) return [...component.members];
    const transformed = ts.transform(component, [context => root => {
      const visit: ts.Visitor = node => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'emit' && ts.isPropertyAccessExpression(node.expression.expression) && node.expression.expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
          const callback = emitTargets.get(node.expression.expression.name.text);
          if (!callback) refuse('emit call on a non-Output member');
          return ts.factory.createCallChain(ts.factory.createPropertyAccessExpression(ts.factory.createThis(), callback), ts.factory.createToken(ts.SyntaxKind.QuestionDotToken), undefined, [...node.arguments]);
        }
        if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword && emitTargets.has(node.name.text)) refuse(`use of EventEmitter member '${node.name.text}' beyond emit()`);
        return ts.visitEachChild(node, visit, context);
      };
      return ts.visitNode(root, visit) as ts.ClassDeclaration;
    }]);
    const result = [...(transformed.transformed[0] as ts.ClassDeclaration).members];
    transformed.dispose();
    return result;
  };
  const memberText = (member: ts.ClassElement): string => {
    if (!ts.isPropertyDeclaration(member)) return printer.printNode(ts.EmitHint.Unspecified, member, file);
    const memberDecorators = ts.getDecorators(member) ?? [];
    if (!memberDecorators.length) return printer.printNode(ts.EmitHint.Unspecified, member, file);
    if (!ts.isIdentifier(member.name)) refuse('Decorated member with a non-identifier name');
    const prefix = (ts.getModifiers(member) ?? []).filter(modifier => !ts.isDecorator(modifier)).map(modifier => modifier.getText(file)).join(' ');
    return `${prefix ? prefix + ' ' : ''}${file.text.slice(member.name.getStart(file), member.end)}`;
  };
  const kept: string[] = [];
  for (const member of transformEmits()) {
    if (ts.isPropertyDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      const role = memberRole.get(member as ts.PropertyDeclaration);
      if (role === 'output') continue;
      if (formField && role !== 'input' && member.name.text === formField.name) continue;
    }
    kept.push(memberText(member));
  }
  for (const output of outputs) kept.push(`${output.callback}?: (value: ${output.eventType}) => void;`);
  if (formField) kept.push(`${formField.name}!: FormState<${className}FormValue>;`);
  const residual = kept.join('\n').match(ANGULAR_REFERENCE);
  if (residual) refuse(`Remaining Angular reference '${residual[0] ?? 'forms'}'`);
  const describeValidators = (validators: Validator[]): string => validators.map(validator => validator.kind === 'compose' ? `compose(${describeValidators(validator.inner ?? [])})` : `${validator.kind}${validator.argument ? `(${validator.argument})` : ''}`).join('; ');
  const ruleLines = (validator: Validator, reference: string): string[] => {
    switch (validator.kind) {
      case 'required': return [`if (${reference} == null || ${reference} === '') controlErrors['required'] = true;`];
      case 'min': return [`{ const actual = parseFloat(String(${reference})); if (!Number.isNaN(actual) && actual < ${validator.argument}) controlErrors['min'] = { min: ${validator.argument}, actual }; }`];
      case 'max': return [`{ const actual = parseFloat(String(${reference})); if (!Number.isNaN(actual) && actual > ${validator.argument}) controlErrors['max'] = { max: ${validator.argument}, actual }; }`];
      case 'minLength': return [`if (${reference} != null && ${reference} !== '') { const actualLength = String(${reference}).length; if (actualLength < ${validator.argument}) controlErrors['minlength'] = { requiredLength: ${validator.argument}, actualLength }; }`];
      case 'maxLength': return [`if (${reference} != null && ${reference} !== '') { const actualLength = String(${reference}).length; if (actualLength > ${validator.argument}) controlErrors['maxlength'] = { requiredLength: ${validator.argument}, actualLength }; }`];
      case 'pattern': {
        const literal = validator.argument ?? refuse('Validators.pattern argument');
        const source = JSON.stringify(literal.startsWith('/') ? literal.slice(1, literal.lastIndexOf('/')) : literal.slice(1, -1));
        return [`if (${reference} != null && ${reference} !== '' && !new RegExp(${literal}).test(String(${reference}))) controlErrors['pattern'] = { requiredPattern: ${source}, actualValue: ${reference} };`];
      }
      default: return [];
    }
  };
  const formRuntime = formField ? [
    'export interface FormState<V> { readonly value: V; readonly valid: boolean; readonly invalid: boolean; getRawValue(): V; }',
    `export type ${className}FormValue = { ${formField.controls.map(control => `${propertyKey(control.name)}: ${control.valueType === 'number' ? 'number | string' : control.valueType}`).join('; ')} };`,
    `export function validate${className}Form(value: ${className}FormValue): Partial<Record<keyof ${className}FormValue, { [error: string]: unknown }>> {`,
    ` const errors: Partial<Record<keyof ${className}FormValue, { [error: string]: unknown }>> = {};`,
    ...formField.controls.map(control => {
      const reference = `value[${JSON.stringify(control.name)}]`;
      const rules = control.validators.flatMap(validator => validator.kind === 'compose' ? (validator.inner ?? []).flatMap(inner => ruleLines(inner, reference)) : ruleLines(validator, reference));
      return ` { const controlErrors: { [error: string]: unknown } = {};\n${rules.map(rule => ` ${rule}`).join('\n')}\n if (Object.keys(controlErrors).length) errors[${JSON.stringify(control.name)}] = controlErrors; }`;
    }),
    ' return errors;',
    '}',
    `export function build${className}Form(value: ${className}FormValue): FormState<${className}FormValue> {`,
    ` const invalid = Object.keys(validate${className}Form(value)).length > 0;`,
    ' return { value, valid: !invalid, invalid, getRawValue: () => value };',
    '}',
  ].join('\n') : '';
  const hasIo = inputs.length > 0 || outputs.length > 0;
  const propsText = hasIo ? `export interface ${className}Props { ${[...inputs.map(input => `${propertyKey(input.alias ?? input.name)}: ${input.type};`), ...outputs.map(output => `${output.callback}?: (value: ${output.eventType}) => void;`)].join(' ')} }` : '';
  const syncLines = [
    ...inputs.map(input => ` ${propertyAccess('model', input.name)} = ${propertyAccess('props', input.alias ?? input.name)};`),
    ...outputs.map(output => ` model.${output.callback} = props.${output.callback};`),
    ...(formField ? [` model.${formField.name} = build${className}Form(formData);`] : []),
  ];
  const functionLines = [
    `export function ${className}${hasIo ? `(props: ${className}Props)` : '()'} {`,
    ...(formField ? [` const [formData, setFormData] = useState<${className}FormValue>({ ${formField.controls.map(control => `${propertyKey(control.name)}: ${control.initial}`).join(', ')} });`] : []),
    ' const ref = useRef<ComponentModel | null>(null);',
    ' if (!ref.current) ref.current = new ComponentModel();',
    ' const model = ref.current;',
    ...syncLines,
    ' const [, refresh] = useReducer(value => value + 1, 0);',
    ...(formField ? [` const setField = (field: keyof ${className}FormValue, value: string | number | boolean) => { setFormData(previous => ({ ...previous, [field]: value } as ${className}FormValue)); refresh(); };`] : []),
    ` return <>${body}</>;\n}`,
  ];
  const code = [`import React, { useReducer, useRef${formField ? ', useState' : ''} } from 'react';`, extra, propsText, formRuntime, `class ComponentModel {\n${kept.join('\n')}\n}`, ...functionLines].filter(Boolean).join('\n') + '\n';
  const mappings: TransformationMapping[] = [{ mappingId: 'component', source: `${fileName}#${className}`, target: `component.tsx#${className}`, preserves: formField ? [...basePreserves, 'VALIDATION'] : basePreserves, rationale: 'Preserved method bodies; adapted supported template bindings, decorated IO and synchronous reactive-form state.' }];
  for (const input of inputs) mappings.push({ mappingId: `input-${input.name}`, source: `${fileName}#${className}#${input.name}`, target: `component.tsx#${className}Props.${input.alias ?? input.name}`, preserves: [], rationale: `Decorated input '${input.name}' exposed as required prop '${input.alias ?? input.name}'${input.alias ? ` (Angular alias; member name '${input.name}' preserved on the model)` : ''} and synchronized into the model on every render.` });
  for (const output of outputs) mappings.push({ mappingId: `output-${output.name}`, source: `${fileName}#${className}#${output.name}`, target: `component.tsx#${className}Props.${output.callback}`, preserves: ['SUCCESS_BEHAVIOR'], rationale: `EventEmitter '${output.name}' payload and call site preserved through callback prop '${output.callback}'.` });
  if (formField) {
    for (const control of formField.controls) mappings.push({ mappingId: `validate-${control.name}`, source: `${fileName}#${className}#${formField.name}.controls.${control.name}`, target: `component.tsx#validate${className}Form.${control.name}`, preserves: ['VALIDATION'], rationale: `Rules preserved explicitly, field-by-field: ${describeValidators(control.validators) || 'none (unvalidated control)'}.` });
    mappings.push({ mappingId: 'form-invalid-gating', source: `${fileName}#${className}#${formField.name}.invalid`, target: `component.tsx#FormState.invalid`, preserves: ['VALIDATION', 'SUCCESS_BEHAVIOR'], rationale: 'Generated valid/invalid flags derive from the explicit validate() result, mirroring Angular [disabled]="form.invalid" submit gating while invalid.' });
  }
  return { code, manifest: { unitId, generatedAt: new Date().toISOString(), transformer: { kind: 'CODEMOD', name: 'standalone-component', version: '0.4.0' }, mappings } };
}

export function repairHttpMethod(code: string, expected: string, actual: string): string {
  if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(expected) || !/^(GET|POST|PUT|PATCH|DELETE)$/.test(actual) || expected === actual) throw new Error('Invalid HTTP method repair.');
  const file = ts.createSourceFile('candidate.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const matches: ts.StringLiteralLike[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fetch') {
      const options = node.arguments[1];
      if (options && ts.isObjectLiteralExpression(options)) for (const property of options.properties) if (ts.isPropertyAssignment(property) && property.name.getText(file) === 'method' && ts.isStringLiteralLike(property.initializer) && property.initializer.text === actual) matches.push(property.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (matches.length !== 1) throw new Error('Method repair requires exactly one matching fetch operation.');
  const node = matches[0]!;
  return code.slice(0, node.getStart(file)) + JSON.stringify(expected) + code.slice(node.end);
}
