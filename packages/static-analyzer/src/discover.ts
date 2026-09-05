import { readFile, readdir, realpath } from 'node:fs/promises';
import { resolve, relative, dirname, extname } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { parseTemplate, BindingPipe } from '@angular/compiler';
import type { MigrationUnit, SymbolRef, DependencyEdge } from '@migration-harness/core';
import { parseMigrationUnit } from '@migration-harness/core';

export interface DiscoveryResult {
  unit: MigrationUnit;
  endpoints: Array<{ symbolId: string; method: string; path: string; dynamic: boolean }>;
  streams: Array<{ symbolId: string; classification: 'request-response' | 'event-stream' | 'state-stream' | 'cancellation-sensitive' | 'orchestration'; operators: string[] }>;
  templates: Array<{ filePath: string; bindings: string[]; errors: string[] }>;
  routes: Array<{ path: string; componentId?: string; guardIds: string[]; resolverIds: string[]; redirectTo?: string; dynamic: boolean }>;
  injections: Array<{ ownerId: string; dependencyId?: string; token: string; lifetime: 'root' | 'component' | 'unknown' }>;
}

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
  let loc = 0, branches = 0;
  for (const file of program.getSourceFiles().filter(file => paths.includes(file.fileName))) {
    loc += file.text.split('\n').length;
    const candidates = file.statements.flatMap<ts.Node>(statement => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations].filter(declaration => /Guard|Resolver|CanActivateFn|ResolveFn/.test(declaration.getText(file))) : [statement]);
    for (const node of candidates) {
      if (!(ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) || !node.name || !ts.isIdentifier(node.name)) continue;
      const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
      const decoratorNames = decorators.map(d => {
        const expression = ts.isCallExpression(d.expression) ? d.expression.expression : d.expression;
        const symbol = checker.getSymbolAtLocation(expression);
        return symbol ? (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol).getName() : expression.getText(file);
      });
      const declaredType = ts.isVariableDeclaration(node) ? node.type?.getText(file) ?? '' : '';
      const kind = /Guard$|CanActivateFn/.test(node.name.text + declaredType) ? 'guard' : /Resolver$|ResolveFn/.test(node.name.text + declaredType) ? 'resolver' : decoratorNames.includes('Component') ? 'component' : decoratorNames.includes('Injectable') ? 'service' : decoratorNames.includes('Directive') ? 'directive' : decoratorNames.includes('Pipe') ? 'pipe' : decoratorNames.includes('NgModule') ? 'module' : 'type_definition';
      const symbol: SymbolRef = { id: `${relative(root, file.fileName)}#${node.name.text}`, name: node.name.text, kind, filePath: relative(root, file.fileName), exported: Boolean(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export), astHash: createHash('sha256').update(node.getText(file)).digest('hex') };
      symbols.push(symbol); declarations.set(node, symbol);
      for (const decorator of decorators) if (ts.isCallExpression(decorator.expression)) {
        const config = decorator.expression.arguments[0];
        if (!config || !ts.isObjectLiteralExpression(config)) continue;
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
            templates.push({ filePath: relative(root, templatePath), bindings, errors: parsed.errors?.map(error => error.toString()) ?? [] });
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
  for (const file of program.getSourceFiles().filter(file => paths.includes(file.fileName))) {
    for (const statement of file.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const name = statement.moduleSpecifier.text;
      const module = ts.resolveModuleName(name, file.fileName, program.getCompilerOptions(), ts.sys).resolvedModule;
      if (module && inside(root, module.resolvedFileName)) continue;
      if (!name.startsWith('.')) external.add(name);
      if (!module) unresolved.push({ name, requestedBy: relative(root, file.fileName), reason: 'Unresolved module import' });
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
          if (method === 'pipe' && owner) {
            const operators = node.arguments.map(arg => ts.isCallExpression(arg) ? arg.expression.getText(file) : arg.getText(file));
            const classification = operators.some(op => ['switchMap', 'takeUntil'].includes(op)) ? 'cancellation-sensitive' : /http/i.test(node.expression.expression.getText(file)) ? 'request-response' : operators.some(op => ['combineLatest', 'mergeMap', 'concatMap'].includes(op)) ? 'orchestration' : 'event-stream';
            streams.push({ symbolId: owner.id, classification, operators });
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
  if (!entries.length || entries.some(id => !symbols.some(s => s.id === id))) throw new Error('Select at least one resolved migration entrypoint.');
  const included = new Set(entries);
  let changed = true;
  while (changed) { changed = false; for (const edge of edges) if (included.has(edge.fromSymbolId) && !included.has(edge.toSymbolId)) { included.add(edge.toSymbolId); changed = true; } }
  const internal = symbols.filter(s => included.has(s.id));
  const unit: MigrationUnit = { id: internal.find(s => entries.includes(s.id))!.name, version: '1.0.0', runtimeRoutes: routes.filter(route => route.componentId && included.has(route.componentId)).map(route => route.path), symbols: internal, dependencyGraph: edges.filter(e => included.has(e.fromSymbolId) && included.has(e.toSymbolId)),
    boundary: { entrypoints: entries, internalSymbols: [...included], externalDependencies: [...external].map(name => ({ name, targetPackage: name, resolvedStrategy: 'keep_external' })) },
    resolutionMetrics: { totalSymbolsIdentified: symbols.length, resolvedSymbolsCount: internal.length, resolutionCoverage: internal.length / Math.max(1, internal.length + unresolved.length), unresolvedSymbols: unresolved, dynamicEdgesCount: unresolved.filter(e => e.reason.startsWith('Dynamic')).length },
    metadata: { loc, cyclomaticComplexity: branches + 1, hasRxjsStreams: streams.length > 0, hasDynamicForms: templates.some(t => t.bindings.some(b => /formArray|ngFor/.test(b))), templateAstComplexityScore: templates.reduce((sum, t) => sum + t.bindings.length, 0) },
  };
  return { unit: parseMigrationUnit(unit), endpoints: endpoints.filter(e => included.has(e.symbolId)), streams: streams.filter(e => included.has(e.symbolId)), templates, routes, injections: injections.filter(injection => included.has(injection.ownerId)) };
}
function inside(root: string, path: string): boolean { const rel = relative(root, path); return !rel.startsWith('..') && !rel.startsWith('/'); }
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
