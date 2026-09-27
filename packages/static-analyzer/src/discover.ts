import { readFile, readdir, realpath } from 'node:fs/promises';
import { resolve, relative, dirname, extname, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { parseTemplate, BindingPipe } from '@angular/compiler';
import type { AsyncValidatorEvidence, ComponentInputRef, ComponentOutputRef, MigrationUnit, ProviderScopeRef, SymbolRef, DependencyEdge } from '@migration-harness/core';
import { parseMigrationUnit } from '@migration-harness/core';

export type StreamClassification = 'request-response' | 'event-stream' | 'state-stream' | 'cancellation-sensitive' | 'orchestration';

export interface DiscoveryResult {
  unit: MigrationUnit;
  endpoints: Array<{ symbolId: string; method: string; path: string; dynamic: boolean }>;
  streams: Array<{ symbolId: string; classification: StreamClassification; operators: string[] }>;
  templates: Array<{ filePath: string; bindings: string[]; errors: string[] }>;
  routes: Array<{ path: string; componentId?: string; guardIds: string[]; resolverIds: string[]; redirectTo?: string; dynamic: boolean }>;
  injections: Array<{ ownerId: string; dependencyId?: string; token: string; lifetime: 'root' | 'component' | 'unknown' }>;
}

const FORM_DIRECTIVES = ['formGroup', 'formControlName', 'formGroupName', 'formArrayName', 'formControl', 'ngModel', 'ngModelGroup', 'ngSubmit'];
const FORM_SYMBOLS = ['FormGroup', 'FormControl', 'FormArray', 'FormBuilder', 'NonNullableFormBuilder', 'Validators', 'ReactiveFormsModule', 'NgModel'];

export async function discover(sourceRoot: string, entrypoints?: string[]): Promise<DiscoveryResult> {
  const root = await realpath(resolve(sourceRoot));
  const paths = await walk(root);
  const configPath = ts.findConfigFile(root, ts.sys.fileExists);
  let options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true };
  if (configPath) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, ' '));
    options = { ...options, ...ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath)).options };
  }
  const program = ts.createProgram(paths.filter(path => /\.[cm]?tsx?$/.test(path)), { ...options, experimentalDecorators: true });
  // TypeScript reports file names with forward slashes; walk() uses OS separators.
  const pathSet = new Set(paths.map(p => resolve(p).split('\\').join('/').toLowerCase()));
  const checker = program.getTypeChecker();
  const symbols: SymbolRef[] = [];
  const edges: DependencyEdge[] = [];
  const unresolved: MigrationUnit['resolutionMetrics']['unresolvedSymbols'] = [];
  const external = new Set<string>();
  const routes: DiscoveryResult['routes'] = [];
  const injections: DiscoveryResult['injections'] = [];
  const endpoints: DiscoveryResult['endpoints'] = [];
  const streams: DiscoveryResult['streams'] = [];
  const templates: DiscoveryResult['templates'] = [];
  const declarations = new Map<ts.Node, SymbolRef>();
  const selectors = new Map<string, SymbolRef>();
  const pipeSymbols = new Map<string, SymbolRef>();
  const lifetimes = new Map<string, 'root' | 'component' | 'unknown'>();
  const rendered: Array<{ owner: SymbolRef; names: Set<string>; pipes: Set<string> }> = [];
  const ioInputs: ComponentInputRef[] = [];
  const ioOutputs: ComponentOutputRef[] = [];
  interface FormsRecord { formsSymbols: Set<string>; templateDirectives: Set<string>; controls: Set<string>; validators: Set<string>; hasAsyncValidators: boolean; hasFormArray: boolean; hasDynamicControlCreation: boolean; subscriptions: Array<{ source: string; semantics: StreamClassification }>; builderGroups: number; builderGroupsNormalized: boolean; asyncValidatorEvidence: AsyncValidatorEvidence[] }
  const formsRecords = new Map<string, FormsRecord>();
  const formsFor = (symbolId: string): FormsRecord => { let record = formsRecords.get(symbolId); if (!record) formsRecords.set(symbolId, record = { formsSymbols: new Set(), templateDirectives: new Set(), controls: new Set(), validators: new Set(), hasAsyncValidators: false, hasFormArray: false, hasDynamicControlCreation: false, subscriptions: [], builderGroups: 0, builderGroupsNormalized: true, asyncValidatorEvidence: [] }); return record; };
  const providerScopes = new Map<string, ProviderScopeRef>();
  const providerScopeFor = (symbolId: string): ProviderScopeRef => { let scope = providerScopes.get(symbolId); if (!scope) providerScopes.set(symbolId, scope = { symbolId, providedIn: 'none', componentProviders: [] }); return scope; };
  const decoratorName = (decorator: ts.Decorator, file: ts.SourceFile): string => {
    const expression = ts.isCallExpression(decorator.expression) ? decorator.expression.expression : decorator.expression;
    const symbol = checker.getSymbolAtLocation(expression);
    return symbol ? (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol).getName() : expression.getText(file);
  };
  const statementTextOf = (node: ts.Node): string => { let current: ts.Node = node; while (current.parent && !ts.isStatement(current)) current = current.parent; return current.getText(); };
  let loc = 0, branches = 0;
  for (const file of program.getSourceFiles().filter(file => pathSet.has(resolve(file.fileName).split('\\').join('/').toLowerCase()))) {
    loc += file.text.split('\n').length;
    const importBindings = new Set<string>();
    for (const statement of file.statements) if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) for (const element of statement.importClause.namedBindings.elements) importBindings.add(element.name.text);
    const candidates = file.statements.flatMap<ts.Node>(statement => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations].filter(declaration => /Guard|Resolver|CanActivateFn|ResolveFn/.test(declaration.getText(file))) : [statement]);
    for (const node of candidates) {
      if (!(ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) || !node.name || !ts.isIdentifier(node.name)) continue;
      const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
      const decoratorNames = decorators.map(decorator => decoratorName(decorator, file));
      const declaredType = ts.isVariableDeclaration(node) ? node.type?.getText(file) ?? '' : '';
      const kind = /Guard$|CanActivateFn/.test(node.name.text + declaredType) ? 'guard' : /Resolver$|ResolveFn/.test(node.name.text + declaredType) ? 'resolver' : decoratorNames.includes('Component') ? 'component' : decoratorNames.includes('Injectable') ? 'service' : decoratorNames.includes('Directive') ? 'directive' : decoratorNames.includes('Pipe') ? 'pipe' : decoratorNames.includes('NgModule') ? 'module' : 'type_definition';
      const relFile = relPosix(root, file.fileName);
      const symbol: SymbolRef = { id: `${relFile}#${node.name.text}`, name: node.name.text, kind, filePath: relFile, exported: Boolean(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export), astHash: createHash('sha256').update(node.getText(file)).digest('hex') };
      symbols.push(symbol); declarations.set(node, symbol);
      if (ts.isClassDeclaration(node) && kind === 'component') {
        for (const member of node.members) {
          if (!ts.isPropertyDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) continue;
          const memberDecorators = ts.canHaveDecorators(member) ? ts.getDecorators(member) ?? [] : [];
          const decorated = memberDecorators.map(decorator => decoratorName(decorator, file)).find(name => name === 'Input' || name === 'Output');
          if (!decorated) continue;
          const aliasNode = memberDecorators.map(decorator => ts.isCallExpression(decorator.expression) ? decorator.expression.arguments[0] : undefined).find(argument => argument !== undefined);
          const alias = aliasNode && ts.isStringLiteralLike(aliasNode) ? aliasNode.text : undefined;
          if (decorated === 'Input') {
            const type = member.type ? member.type.getText(file) : checker.typeToString(checker.getTypeAtLocation(member.name));
            ioInputs.push({ symbolId: symbol.id, name: member.name.text, ...(alias ? { alias } : {}), type: type || 'unknown' });
          } else {
            const typeArguments = (member.initializer && ts.isNewExpression(member.initializer) ? member.initializer.typeArguments : undefined) ?? (member.type && ts.isTypeReferenceNode(member.type) ? member.type.typeArguments : undefined);
            ioOutputs.push({ symbolId: symbol.id, name: member.name.text, ...(alias ? { alias } : {}), eventType: typeArguments?.[0]?.getText(file) ?? 'void' });
          }
        }
        const classText = node.getText(file);
        const formSymbolHits = FORM_SYMBOLS.filter(formSymbol => new RegExp(`\\b${formSymbol}\\b`).test(classText));
        const validatorHits = [...classText.matchAll(/\bValidators\s*\.\s*(\w+)/g)].map(match => match[1] ?? '');
        const hasAsyncValidators = /\basyncValidators\b/.test(classText);
        const hasFormArray = /\bFormArray\b/.test(classText);
        const hasDynamicControlCreation = /\.\s*(?:addControl|setControl|removeControl)\s*\(/.test(classText);
        if (formSymbolHits.length || validatorHits.length || hasAsyncValidators || hasFormArray || hasDynamicControlCreation) {
          const record = formsFor(symbol.id);
          for (const hit of formSymbolHits) record.formsSymbols.add(hit);
          for (const hit of validatorHits) record.validators.add(hit);
          record.hasAsyncValidators ||= hasAsyncValidators; record.hasFormArray ||= hasFormArray; record.hasDynamicControlCreation ||= hasDynamicControlCreation;
        }
        const isBuilderReceiver = (receiver: ts.Expression): boolean => {
          const text = receiver.getText(file);
          return /^(?:this\.)?(?:fb|formBuilder|builder)$/.test(text) || /^new\s+(?:NonNullable)?FormBuilder\(\)$/.test(text) || /^inject\(\s*(?:NonNullable)?FormBuilder\s*\)$/.test(text);
        };
        const literalControlValue = (value: ts.Expression): boolean => ts.isStringLiteralLike(value) || ts.isNumericLiteral(value) || (ts.isPrefixUnaryExpression(value) && ts.isNumericLiteral(value.operand)) || value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword;
        const validatorNames = (node: ts.Expression): string[] => {
          if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.UndefinedKeyword) return [];
          if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(validatorNames);
          if (ts.isPropertyAccessExpression(node) && node.expression.getText(file) === 'Validators') return [node.name.text];
          if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(file) === 'Validators') return node.expression.name.text === 'compose' ? node.arguments.flatMap(validatorNames) : [node.expression.name.text];
          return [node.getText(file)];
        };
        const asyncValidatorScope = (node: ts.Expression): AsyncValidatorEvidence['scope'] => {
          if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) return 'local';
          if (ts.isIdentifier(node)) {
            if (importBindings.has(node.text)) { unresolved.push({ name: node.text, requestedBy: symbol.id, reason: 'Imported async validator requires explicit resolution' }); return 'imported'; }
            const target = checker.getSymbolAtLocation(node);
            if (target?.declarations?.some(declaration => !ts.isImportSpecifier(declaration) && inside(root, declaration.getSourceFile().fileName))) return 'local';
          }
          unresolved.push({ name: node.getText(file).slice(0, 480), requestedBy: symbol.id, reason: 'Async validator reference is unresolved' });
          return 'unknown';
        };
        const recordAsyncEvidence = (field: string, node: ts.Expression): void => {
          const elements = ts.isArrayLiteralExpression(node) ? [...node.elements] : [node];
          const names = elements.map(element => element.getText(file));
          const scopes = elements.map(asyncValidatorScope);
          const scope: AsyncValidatorEvidence['scope'] = scopes.includes('unknown') ? 'unknown' : scopes.includes('imported') ? 'imported' : 'local';
          const record = formsFor(symbol.id);
          record.asyncValidatorEvidence.push({ field, validators: names, scope });
          record.hasAsyncValidators = true;
        };
        const parseGroupConfig = (config: ts.ObjectLiteralExpression, builder: boolean): { controls: string[]; ok: boolean } => {
          const controls: string[] = []; let ok = config.properties.length > 0;
          const addSync = (node: ts.Expression) => { for (const name of validatorNames(node)) formsFor(symbol.id).validators.add(name); };
          const readControl = (field: string, value: ts.Expression): void => {
            if (ts.isNewExpression(value) && value.expression.getText(file) === 'FormControl' && !value.typeArguments?.length) {
              const args = value.arguments ?? [];
              if (args.length > 3 || (!args.length || !literalControlValue(args[0]!))) { ok = false; return; }
              if (args[1] && ts.isObjectLiteralExpression(args[1])) {
                for (const option of args[1].properties) {
                  if (!ts.isPropertyAssignment(option)) { ok = false; continue; }
                  const key = option.name.getText(file);
                  if (key === 'asyncValidators' || key === 'asyncValidator') recordAsyncEvidence(field, option.initializer);
                  else if (key === 'validators') addSync(option.initializer);
                  else if (key !== 'nonNullable' && key !== 'updateOn') ok = false;
                }
              } else if (args[1]) addSync(args[1]);
              if (args[2] && args[2].kind !== ts.SyntaxKind.NullKeyword) recordAsyncEvidence(field, args[2]);
              controls.push(field);
            } else if (builder && ts.isArrayLiteralExpression(value) && value.elements.length >= 1 && value.elements.length <= 3) {
              const [initial, syncNode, asyncNode]: (ts.Expression | undefined)[] = [...value.elements];
              if (!initial || !literalControlValue(initial)) { ok = false; return; }
              if (syncNode) addSync(syncNode);
              if (asyncNode && asyncNode.kind !== ts.SyntaxKind.NullKeyword) recordAsyncEvidence(field, asyncNode);
              controls.push(field);
            } else if (builder && literalControlValue(value)) controls.push(field);
            else ok = false;
          };
          for (const property of config.properties) {
            if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) { ok = false; continue; }
            readControl(property.name.text, property.initializer);
          }
          return { controls, ok };
        };
        for (const member of node.members) {
          if (!ts.isPropertyDeclaration(member) || !member.initializer || !member.name || !ts.isIdentifier(member.name)) continue;
          const initializer = member.initializer;
          let config: ts.Expression | undefined; let builder = false;
          if (ts.isNewExpression(initializer) && initializer.expression.getText(file) === 'FormGroup') config = initializer.arguments?.[0];
          else if (ts.isCallExpression(initializer) && ts.isPropertyAccessExpression(initializer.expression) && initializer.expression.name.text === 'group' && isBuilderReceiver(initializer.expression.expression)) { config = initializer.arguments[0]; builder = true; }
          if (config === undefined && !builder) continue;
          const record = formsFor(symbol.id);
          if (builder) record.builderGroups++;
          if (config && ts.isObjectLiteralExpression(config)) {
            const parsed = parseGroupConfig(config, builder);
            for (const control of parsed.controls) record.controls.add(control);
            if (!parsed.ok && builder) { record.builderGroupsNormalized = false; unresolved.push({ name: `${symbol.name}#${member.name.text} group configuration`, requestedBy: symbol.id, reason: 'Builder form group configuration is not statically resolvable' }); }
          } else if (builder) { record.builderGroupsNormalized = false; unresolved.push({ name: `${symbol.name}#${member.name.text} group configuration`, requestedBy: symbol.id, reason: 'Builder form group configuration is not statically resolvable' }); }
        }
      }
      for (const decorator of decorators) if (ts.isCallExpression(decorator.expression)) {
        const config = decorator.expression.arguments[0];
        if (!config || !ts.isObjectLiteralExpression(config)) continue;
        for (const property of config.properties) if (ts.isPropertyAssignment(property)) {
          const key = property.name.getText(file);
          const value = property.initializer;
          if (key === 'providedIn') {
            const scope = providerScopeFor(symbol.id);
            if (ts.isStringLiteralLike(value)) scope.providedIn = value.text === 'root' || value.text === 'platform' || value.text === 'any' ? value.text : 'unknown';
            else if (ts.isIdentifier(value) || ts.isPropertyAccessExpression(value)) { scope.providedIn = 'type'; scope.token = value.getText(file); }
            else scope.providedIn = 'unknown';
          }
          if (key === 'providers') {
            const scope = providerScopeFor(symbol.id);
            if (ts.isArrayLiteralExpression(value)) scope.componentProviders = value.elements.map(element => ts.isIdentifier(element) ? element.text : element.getText(file).replace(/\s+/g, ' ').slice(0, 200));
            if (scope.componentProviders.length && (symbol.kind === 'component' || symbol.kind === 'directive')) for (const name of scope.componentProviders) unresolved.push({ name, requestedBy: symbol.id, reason: 'Component-level provider requires scope resolution' });
          }
        }
        for (const property of config.properties) if (ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer)) {
          const key = property.name.getText(file);
          if (key === 'selector') selectors.set(property.initializer.text, symbol);
          if (key === 'name' && symbol.kind === 'pipe') pipeSymbols.set(property.initializer.text, symbol);
          if (key === 'providedIn') lifetimes.set(symbol.id, property.initializer.text === 'root' ? 'root' : 'unknown');
          if (key === 'template' || key === 'templateUrl') {
            const templatePath = key === 'templateUrl' ? await realpath(resolve(dirname(file.fileName), property.initializer.text)) : file.fileName;
            if (!inside(root, templatePath)) throw new Error('Template escapes source boundary.');
            const content = key === 'template' ? property.initializer.text : await readFile(templatePath, 'utf8');
            const parsed = parseTemplate(content, templatePath);
            const bindings: string[] = [];
            const names = new Set<string>(), pipes = new Set<string>();
            const seen = new Set<object>();
            const scanExpression = (value: unknown): void => {
              if (!value || typeof value !== 'object' || seen.has(value)) return;
              seen.add(value);
              if (value instanceof BindingPipe) pipes.add(value.name);
              for (const child of Object.values(value)) scanExpression(child);
            };
            const scan = (nodes: readonly unknown[]): void => { for (const raw of nodes) {
              const item = raw as { name?: string; attributes?: Array<{name: string}>; inputs?: Array<{name: string}>; outputs?: Array<{name: string}>; children?: unknown[]; templateAttrs?: Array<{name: string}> };
              if (item.name) names.add(item.name);
              for (const attr of [...item.attributes ?? [], ...item.inputs ?? [], ...item.templateAttrs ?? []]) names.add(`[${attr.name}]`);
              bindings.push(...[...item.inputs ?? [], ...item.outputs ?? [], ...item.templateAttrs ?? []].map(b => b.name));
              scanExpression(item);
              if (item.children) scan(item.children);
            } };
            scan(parsed.nodes);
            const formDirectives = FORM_DIRECTIVES.filter(directive => names.has(`[${directive}]`) || bindings.includes(directive));
            if (formDirectives.length) { const record = formsFor(symbol.id); for (const directive of formDirectives) record.templateDirectives.add(directive); if (formDirectives.includes('formArrayName')) record.hasFormArray = true; }
            templates.push({ filePath: relPosix(root, templatePath), bindings, errors: parsed.errors?.map(error => error.toString()) ?? [] });
            rendered.push({ owner: symbol, names, pipes });
          }
        }
      }
    }
  }
  const resolveSymbol = (node: ts.Node): SymbolRef | undefined => {
    const reference = checker.getSymbolAtLocation(node);
    const target = reference && (reference.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(reference) : reference);
    return target?.declarations?.map(declaration => declarations.get(declaration)).find(Boolean);
  };
  for (const template of rendered) {
    for (const name of template.names) {
      const target = selectors.get(name);
      if (target && target.id !== template.owner.id) edges.push({ fromSymbolId: template.owner.id, toSymbolId: target.id, relation: target.kind === 'directive' ? 'applies_directive' : 'renders', isDynamic: false });
    }
    for (const name of template.pipes) {
      const target = pipeSymbols.get(name);
      if (target) edges.push({ fromSymbolId: template.owner.id, toSymbolId: target.id, relation: 'pipes_through', isDynamic: false });
      else unresolved.push({ name, requestedBy: template.owner.id, reason: 'Template pipe is external or unresolved' });
    }
  }
  for (const file of program.getSourceFiles().filter(file => pathSet.has(resolve(file.fileName).split('\\').join('/').toLowerCase()))) {
    for (const statement of file.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const name = statement.moduleSpecifier.text;
      const module = ts.resolveModuleName(name, file.fileName, program.getCompilerOptions(), ts.sys).resolvedModule;
      if (module && inside(root, module.resolvedFileName)) continue;
      if (!name.startsWith('.')) external.add(name);
      if (!module) unresolved.push({ name, requestedBy: relPosix(root, file.fileName), reason: 'Unresolved module import' });
    }
    const visit = (node: ts.Node, owner?: SymbolRef): void => {
      owner = declarations.get(node) ?? owner;
      if (owner && ts.isIdentifier(node)) {
        const dependency = resolveSymbol(node);
        if (dependency && dependency.id !== owner.id && !edges.some(edge => edge.fromSymbolId === owner.id && edge.toSymbolId === dependency.id)) edges.push({ fromSymbolId: owner.id, toSymbolId: dependency.id, relation: 'imports', isDynamic: false });
      }
      if (ts.isIfStatement(node) || ts.isConditionalExpression(node) || ts.isCaseClause(node)) branches++;
      if (owner && ts.isConstructorDeclaration(node)) for (const parameter of node.parameters) {
        const token = parameter.type && ts.isTypeReferenceNode(parameter.type) ? parameter.type.typeName : undefined;
        const dependency = token ? resolveSymbol(token) : undefined;
        injections.push({ ownerId: owner.id, ...(dependency ? { dependencyId: dependency.id } : {}), token: token?.getText(file) ?? parameter.name.getText(file), lifetime: dependency ? lifetimes.get(dependency.id) ?? 'unknown' : 'unknown' });
        if (dependency) edges.push({ fromSymbolId: owner.id, toSymbolId: dependency.id, relation: 'injects', isDynamic: false });
        else unresolved.push({ name: token?.getText(file) ?? parameter.name.getText(file), requestedBy: owner.id, reason: 'Constructor injection requires token/provider resolution' });
      }
      if (ts.isCallExpression(node)) {
        if (owner && ts.isIdentifier(node.expression) && node.expression.text === 'fetch' && node.arguments[0]) {
          const path = node.arguments[0], options = node.arguments[1];
          const property = options && ts.isObjectLiteralExpression(options) ? options.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(file) === 'method') : undefined;
          const method = property && ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer) ? property.initializer.text.toUpperCase() : 'GET';
          endpoints.push({ symbolId: owner.id, method, path: ts.isStringLiteralLike(path) ? path.text : path.getText(file), dynamic: !ts.isStringLiteralLike(path) || Boolean(options && !ts.isObjectLiteralExpression(options)) });
        }
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) unresolved.push({ name: node.getText(file), requestedBy: owner?.id ?? file.fileName, reason: 'Dynamic import requires runtime resolution' });
        if (ts.isPropertyAccessExpression(node.expression)) {
          const method = node.expression.name.text;
          const argument = node.arguments[0];
          if (['get', 'post', 'put', 'patch', 'delete'].includes(method) && argument && owner) {
            const receiverType = checker.typeToString(checker.getTypeAtLocation(node.expression.expression));
            if (/HttpClient/.test(receiverType) || /http/i.test(node.expression.expression.getText(file))) endpoints.push({ symbolId: owner.id, method: method.toUpperCase(), path: ts.isStringLiteralLike(argument) ? argument.text : argument.getText(file), dynamic: !ts.isStringLiteralLike(argument) });
          }
          const receiverText = node.expression.expression.getText(file);
          if (method === 'pipe' && owner) {
            const operators = node.arguments.map(arg => ts.isCallExpression(arg) ? arg.expression.getText(file) : arg.getText(file));
            const subscriptionSource = /valueChanges|statusChanges/.test(receiverText) ? (receiverText.includes('statusChanges') ? 'statusChanges' : 'valueChanges') : undefined;
            const cancellation = operators.some(op => ['switchMap', 'takeUntil'].includes(op));
            const requesting = /http|fetch\(|\.(?:get|post|put|patch|delete|request)\s*\(/i.test(statementTextOf(node));
            const orchestrating = operators.some(op => ['combineLatest', 'mergeMap', 'concatMap'].includes(op));
            const classification: StreamClassification = subscriptionSource ? cancellation ? 'cancellation-sensitive' : requesting ? 'request-response' : orchestrating ? 'orchestration' : 'state-stream' : cancellation ? 'cancellation-sensitive' : /http/i.test(receiverText) ? 'request-response' : orchestrating ? 'orchestration' : 'event-stream';
            streams.push({ symbolId: owner.id, classification, operators });
            if (subscriptionSource && owner.kind === 'component') formsFor(owner.id).subscriptions.push({ source: subscriptionSource, semantics: classification });
          }
          if (method === 'subscribe' && owner?.kind === 'component' && /valueChanges|statusChanges/.test(receiverText) && !receiverText.includes('.pipe(')) {
            const semantics: StreamClassification = /http|fetch\(|\.(?:get|post|put|patch|delete|request)\s*\(/i.test(statementTextOf(node)) ? 'request-response' : 'state-stream';
            streams.push({ symbolId: owner.id, classification: semantics, operators: [] });
            formsFor(owner.id).subscriptions.push({ source: receiverText.includes('statusChanges') ? 'statusChanges' : 'valueChanges', semantics });
          }
        }
        if (owner && node.expression.getText(file) === 'inject' && node.arguments[0]) {
          const dependency = resolveSymbol(node.arguments[0]);
          injections.push({ ownerId: owner.id, ...(dependency ? { dependencyId: dependency.id } : {}), token: node.arguments[0].getText(file), lifetime: dependency ? lifetimes.get(dependency.id) ?? 'unknown' : 'unknown' });
          if (dependency) edges.push({ fromSymbolId: owner.id, toSymbolId: dependency.id, relation: 'injects', isDynamic: false });
          else unresolved.push({ name: node.arguments[0].getText(file), requestedBy: owner.id, reason: 'Injection target is external or unresolved' });
        }
      }
      if (ts.isNewExpression(node) && /BehaviorSubject|ReplaySubject/.test(node.expression.getText(file)) && owner) streams.push({ symbolId: owner.id, classification: 'state-stream', operators: [] });
      ts.forEachChild(node, child => visit(child, owner));
    };
    visit(file);
    const readRoutes = (value: ts.Expression, prefix = ''): void => {
      if (!ts.isArrayLiteralExpression(value)) return;
      for (const item of value.elements) if (ts.isObjectLiteralExpression(item)) {
        const properties = new Map(item.properties.flatMap(property => ts.isPropertyAssignment(property) ? [[property.name.getText(file).replace(/^['"]|['"]$/g, ''), property.initializer] as const] : []));
        const pathValue = properties.get('path');
        if (!pathValue || !ts.isStringLiteralLike(pathValue)) { unresolved.push({ name: item.getText(file), requestedBy: file.fileName, reason: 'Dynamic route path' }); continue; }
        const path = `${prefix}/${pathValue.text}`.replace(/\/$/, '') || '/';
        const componentNode = properties.get('component'), component = componentNode ? resolveSymbol(componentNode) : undefined;
        const guardIds: string[] = [], resolverIds: string[] = [];
        for (const key of ['canActivate', 'canActivateChild', 'canMatch', 'canDeactivate', 'resolve']) {
          const expression = properties.get(key);
          const refs = expression && ts.isArrayLiteralExpression(expression) ? [...expression.elements] : expression && ts.isObjectLiteralExpression(expression) ? expression.properties.flatMap(p => ts.isPropertyAssignment(p) ? [p.initializer] : []) : [];
          for (const ref of refs) {
            const dependency = resolveSymbol(ref);
            if (dependency) {
              (key === 'resolve' ? resolverIds : guardIds).push(dependency.id);
              if (component) edges.push({ fromSymbolId: component.id, toSymbolId: dependency.id, relation: key === 'resolve' ? 'resolves' : 'guards', isDynamic: false });
            } else unresolved.push({ name: ref.getText(file), requestedBy: path, reason: 'Route guard or resolver is unresolved' });
          }
        }
        const redirect = properties.get('redirectTo');
        routes.push({ path, ...(component ? { componentId: component.id } : {}), guardIds, resolverIds, ...(redirect && ts.isStringLiteralLike(redirect) ? { redirectTo: redirect.text } : {}), dynamic: properties.has('loadComponent') || properties.has('loadChildren') || Boolean(componentNode && !component) });
        const children = properties.get('children'); if (children) readRoutes(children, path === '/' ? '' : path);
      }
    };
    for (const statement of file.statements) if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (declaration.initializer && (/routes/i.test(declaration.name.getText(file)) || declaration.type?.getText(file) === 'Routes')) readRoutes(declaration.initializer);
  }
  const components = symbols.filter(s => s.kind === 'component');
  if (!entrypoints && components.length !== 1) throw new Error('Multiple or missing components: select explicit entrypoints.');
  const entries = entrypoints ?? components.map(s => s.id);
  const resolveEntry = (id: string) => {
    const name = id.split('#').at(-1) ?? id;
    const fileHint = (id.split('#')[0] ?? '').split(/[\\/]/).pop() ?? '';
    return symbols.find(s => s.id === id)
      // Tolerate OS path-form differences in the file segment of `path#Name` entrypoint ids.
      ?? symbols.find(s => s.name === name && s.filePath.split(/[\\/]/).pop() === fileHint)
      ?? symbols.find(s => s.name === name);
  };
  if (!entries.length || entries.some(id => !resolveEntry(id))) throw new Error('Select at least one resolved migration entrypoint.');
  const included = new Set(entries.map(id => resolveEntry(id)!.id));
  const entryIds = new Set(entries.map(id => resolveEntry(id)!.id));
  let changed = true;
  while (changed) { changed = false; for (const edge of edges) if (included.has(edge.fromSymbolId) && !included.has(edge.toSymbolId)) { included.add(edge.toSymbolId); changed = true; } }
  const internal = symbols.filter(s => included.has(s.id));
  const unit: MigrationUnit = { id: internal.find(s => entryIds.has(s.id))!.name, version: '1.0.0', runtimeRoutes: routes.filter(route => route.componentId && included.has(route.componentId)).map(route => route.path), symbols: internal, dependencyGraph: edges.filter(e => included.has(e.fromSymbolId) && included.has(e.toSymbolId)),
    inputs: ioInputs.filter(input => included.has(input.symbolId)), outputs: ioOutputs.filter(output => included.has(output.symbolId)),
    reactiveForms: [...formsRecords].filter(([symbolId]) => included.has(symbolId)).map(([symbolId, record]) => ({ symbolId, formsSymbols: [...record.formsSymbols].sort(), templateDirectives: [...record.templateDirectives].sort(), controls: [...record.controls].sort(), validators: [...record.validators].sort(), hasAsyncValidators: record.hasAsyncValidators, hasFormArray: record.hasFormArray, hasDynamicControlCreation: record.hasDynamicControlCreation, subscriptions: record.subscriptions, builderInferred: record.builderGroups > 0 && record.builderGroupsNormalized, asyncValidatorEvidence: record.asyncValidatorEvidence })),
    providerScopes: [...providerScopes].filter(([symbolId]) => included.has(symbolId)).map(([symbolId, scope]) => ({ symbolId, providedIn: scope.providedIn, ...(scope.token ? { token: scope.token } : {}), componentProviders: scope.componentProviders })),
    boundary: { entrypoints: entries, internalSymbols: [...included], externalDependencies: [...external].map(name => ({ name, targetPackage: name, resolvedStrategy: 'keep_external' })) },
    resolutionMetrics: { totalSymbolsIdentified: symbols.length, resolvedSymbolsCount: internal.length, resolutionCoverage: internal.length / Math.max(1, internal.length + unresolved.length), unresolvedSymbols: unresolved, dynamicEdgesCount: unresolved.filter(e => e.reason.startsWith('Dynamic')).length },
    metadata: { loc, cyclomaticComplexity: branches + 1, hasRxjsStreams: streams.length > 0, hasDynamicForms: templates.some(t => t.bindings.some(b => /formArray|ngFor/.test(b))), templateAstComplexityScore: templates.reduce((sum, t) => sum + t.bindings.length, 0) },
  };
  return { unit: parseMigrationUnit(unit), endpoints: endpoints.filter(e => included.has(e.symbolId)), streams: streams.filter(e => included.has(e.symbolId)), templates, routes, injections: injections.filter(injection => included.has(injection.ownerId)) };
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(/[/\\]/).includes('..'));
}
/** Stable POSIX-relative id segment so entrypoint matching works with TS's forward-slash file names on Windows. */
function relPosix(root: string, file: string): string {
  const r = resolve(root).split('\\').join('/');
  const f = resolve(file).split('\\').join('/');
  const fold = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  if (fold(f) === fold(r)) return '';
  if (fold(f).startsWith(fold(r) + '/')) return f.slice(r.length + 1);
  return relative(root, file).split('\\').join('/');
}
async function walk(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || ['node_modules', 'dist', '.git', '.migration-private', 'artifacts'].includes(entry.name)) continue;
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else if (['.ts', '.tsx', '.html'].includes(extname(path))) result.push(path);
  }
  return result;
}
