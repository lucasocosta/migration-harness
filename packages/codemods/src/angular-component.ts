import ts from 'typescript';
import { parseTemplate } from '@angular/compiler';
import type { TransformationManifest } from '@migration-harness/core';

export interface ComponentTransformation { code: string; manifest: TransformationManifest; }

/** Deliberately narrow adapter: unsupported Angular semantics require a worker/review. */
export function transformAngularComponent(source: string, unitId: string, fileName = 'component.ts'): ComponentTransformation {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const classes = file.statements.filter(ts.isClassDeclaration);
  const component = classes.find(node => (ts.getDecorators(node) ?? []).some(d => ts.isCallExpression(d.expression) && d.expression.expression.getText(file) === 'Component'));
  if (!component?.name || classes.length !== 1) throw new Error('Codemod supports one standalone component per file.');
  const decorator = ts.getDecorators(component)!.find(d => ts.isCallExpression(d.expression) && d.expression.expression.getText(file) === 'Component')!;
  const call = decorator.expression as ts.CallExpression;
  const config = call.arguments[0];
  if (!config || !ts.isObjectLiteralExpression(config)) throw new Error('Component metadata must be literal.');
  const templateProperty = config.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(file) === 'template');
  if (!templateProperty || !ts.isPropertyAssignment(templateProperty) || !ts.isStringLiteralLike(templateProperty.initializer)) throw new Error('Codemod requires an inline literal template.');
  for (const property of config.properties) if (!ts.isPropertyAssignment(property) || !['selector', 'standalone', 'template'].includes(property.name.getText(file))) throw new Error('Component metadata needs semantic review.');
  if (component.heritageClauses?.length || component.members.some(member => ts.isConstructorDeclaration(member) || (ts.canHaveDecorators(member) && ts.getDecorators(member)?.length))) throw new Error('Inheritance, injection and decorated members need semantic review.');
  if (component.members.some(member => member.name?.getText(file).startsWith('ng'))) throw new Error('Lifecycle hooks need semantic review.');
  const members = new Set(component.members.flatMap(member => member.name && ts.isIdentifier(member.name) ? [member.name.text] : []));
  const expression = (value: string): string => {
    const parsed = ts.createSourceFile('expression.ts', `(${value})`, ts.ScriptTarget.Latest, true);
    const transformed = ts.transform(parsed, [context => root => {
      const visit: ts.Visitor = node => {
        if (ts.isIdentifier(node) && node.text === '$event') return ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier('event'), 'nativeEvent');
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
    const attributes = (node.attributes ?? []).map(a => `${a.name === 'class' ? 'className' : a.name === 'for' ? 'htmlFor' : a.name}=${JSON.stringify(a.value)}`);
    for (const input of node.inputs ?? []) {
      if (!['value', 'hidden', 'disabled', 'checked', 'required', 'title'].includes(input.name) || !input.value.source) throw new Error('Unsupported template binding.');
      attributes.push(`${input.name}={${expression(input.value.source)}}`);
    }
    for (const output of node.outputs ?? []) {
      const name = ({ click: 'onClick', input: 'onChange', change: 'onChange', submit: 'onSubmit' } as Record<string, string>)[output.name];
      if (!name || !output.handler.source) throw new Error('Unsupported template event.');
      attributes.push(`${name}={async (event) => { await ${expression(output.handler.source)}; refresh(); }}`);
    }
    const start = `<${node.name}${attributes.length ? ' ' + attributes.join(' ') : ''}`;
    return ['input', 'br', 'hr', 'img'].includes(node.name) ? `${start} />` : `${start}>${(node.children ?? []).map(render).join('')}</${node.name}>`;
  };
  const body = template.nodes.map(render).join('');
  const model = ts.factory.updateClassDeclaration(component, undefined, ts.factory.createIdentifier('ComponentModel'), component.typeParameters, undefined, component.members);
  const printer = ts.createPrinter();
  const extra = file.statements.filter(node => ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)).map(node => printer.printNode(ts.EmitHint.Unspecified, node, file)).join('\n');
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      const bindings = statement.importClause?.namedBindings;
      if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== '@angular/core' || !bindings || !ts.isNamedImports(bindings) || bindings.elements.some(element => element.name.text !== 'Component' || element.propertyName)) throw new Error('Imported dependencies require semantic transformation.');
    } else if (statement !== component && !ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) throw new Error('Top-level behavior requires semantic transformation.');
  }
  const code = `import React, { useReducer, useRef } from 'react';\n${extra}\n${printer.printNode(ts.EmitHint.Unspecified, model, file)}\nexport function ${component.name.text}() {\n const ref = useRef<ComponentModel | null>(null);\n if (!ref.current) ref.current = new ComponentModel();\n const model = ref.current;\n const [, refresh] = useReducer(value => value + 1, 0);\n return <>${body}</>;\n}\n`;
  return { code, manifest: { unitId, generatedAt: new Date().toISOString(), transformer: { kind: 'CODEMOD', name: 'standalone-component', version: '0.3.0' }, mappings: [{ mappingId: 'component', source: `${fileName}#${component.name.text}`, target: `component.tsx#${component.name.text}`, preserves: ['HTTP_METHOD', 'HTTP_PATH', 'HTTP_PAYLOAD', 'HTTP_STATUS', 'STORAGE', 'ARIA_SEMANTICS'], rationale: 'Preserved method bodies; adapted supported template bindings and event-driven rendering.' }] } };
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
