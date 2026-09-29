import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, parseOpenApiRefMap, privateBaseDir, HttpEndpointInvariantSchema, type HttpEndpointInvariant, type Invariant } from '@migration-harness/core';

export interface ImportedHttpEvidence {
  invariants: Invariant<HttpEndpointInvariant>[];
  unresolved: Array<{ reference: string; reason: string }>;
}

export interface OpenApiImportOptions {
  /** Maps external $ref prefixes to local JSON documents or directories on disk. Resolution happens strictly through this mapping and is never fetched; unmapped external refs stay review findings. */
  refMap?: Record<string, string>;
  privateRoots?: string[];
}

/** Imports a bounded OpenAPI 3.0/3.1 subset. External references are never fetched; only ref-mapped ones resolve from disk, under containment and budget guards. */
export function importOpenApi(input: unknown, sourceReference: string, options: OpenApiImportOptions = {}): ImportedHttpEvidence {
  const document = object(input);
  if (typeof document.openapi !== 'string' || !/^3\.[01]\./.test(document.openapi)) throw new Error('OpenAPI 3.0 or 3.1 is required.');
  if (!sourceReference.trim()) throw new Error('Evidence requires source provenance.');
  const refMap = options.refMap === undefined ? undefined : parseOpenApiRefMap(options.refMap);
  const result: ImportedHttpEvidence = { invariants: [], unresolved: [] };
  const externalDocuments = new Map<string, Record<string, unknown>>();
  type DocumentContext = { root: Record<string, unknown>; location: string };
  const contexts = new WeakMap<object, DocumentContext>();
  const bindDocument = (root: Record<string, unknown>, location: string): void => {
    const context = { root, location }, pending: unknown[] = [root];
    let nodes = 0;
    while (pending.length) {
      const value = pending.pop();
      if (!value || typeof value !== 'object' || contexts.has(value)) continue;
      if (++nodes > 200000) throw new Error('Reference document exceeds the structure budget.');
      contexts.set(value, context);
      for (const child of Object.values(value)) pending.push(child);
    }
  };
  bindDocument(document, sourceReference);
  const pointer = (root: unknown, ref: string, tokens: string[]): Record<string, unknown> => {
    let target: unknown = root;
    for (const token of tokens.map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
      const record = object(target);
      if (!Object.hasOwn(record, token) || ['__proto__', 'constructor', 'prototype'].includes(token)) throw new Error(`Unresolved reference ${ref}`);
      target = record[token];
    }
    return object(target);
  };
  // Bounded disk reader for ref-mapped locations only: containment before and after realpath (no symlink
  // escapes), private-root refusal, a JSON-document budget and a per-file size cap. Nothing is ever fetched.
  const loadMapped = (location: string, ref: string): Record<string, unknown> => {
    const prefix = refMap ? Object.keys(refMap).filter(key => location.startsWith(key)).sort((a, b) => b.length - a.length)[0] : undefined;
    const mapped = prefix === undefined || !refMap ? undefined : refMap[prefix];
    if (!prefix || !mapped) throw new Error('External or cyclic references require review.');
    const remainder = location.slice(prefix.length);
    if (remainder && (prefix.endsWith('.json') || remainder.startsWith('/') || remainder.includes('\\') || remainder.includes('?') || remainder.includes(':') || remainder.split('/').some(part => part === '' || part === '.' || part === '..'))) throw new Error('Mapped reference escapes its ref-map root.');
    const readable = (path: string): string => { try { return realpathSync(path); } catch { throw new Error(`Unreadable mapped reference ${ref}`); } };
    const root = readable(resolvePath(mapped));
    let file = root;
    if (statSync(root).isDirectory()) {
      if (!remainder) throw new Error('Mapped directory references require a JSON file path.');
      const joined = resolvePath(root, ...remainder.split('/'));
      const contained = relative(root, joined);
      if (!contained || contained.startsWith('..') || isAbsolute(contained)) throw new Error('Mapped reference escapes its ref-map root.');
      file = readable(joined);
      if (file !== root && !file.startsWith(root + sep)) throw new Error('Mapped reference escapes its ref-map root.');
    } else if (remainder) throw new Error('Mapped file references cannot carry additional path segments.');
    // The input guards refuse the private artifact domain wherever it resolves, after containment.
    const privateRoots = [privateBaseDir(), ...(options.privateRoots ?? [])].map(root => {
      try { return realpathSync(resolvePath(root)); } catch { return resolvePath(root); }
    });
    if (file.split(/[\\/]/).includes('.migration-private') || privateRoots.some(root => file === root || file.startsWith(root + sep))) throw new Error('Mapped references cannot resolve into a private root.');
    if (!file.endsWith('.json')) throw new Error('Mapped references must resolve to JSON documents.');
    const identity = `${file}\n${location}`;
    const cached = externalDocuments.get(identity);
    if (cached) return cached;
    if (externalDocuments.size >= 64) throw new Error('Mapped references exceed the external document budget.');
    if (statSync(file).size > 4_194_304) throw new Error('Mapped references exceed the document size budget.');
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`Unreadable mapped reference ${ref}`); }
    const external = object(parsed);
    bindDocument(external, location);
    externalDocuments.set(identity, external);
    return external;
  };
  const resolve = (value: unknown): Record<string, unknown> => {
    let current = object(value);
    let context = contexts.get(current) ?? { root: document, location: sourceReference };
    const visited = new Set<string>();
    while (Object.hasOwn(current, '$ref')) {
      if (typeof current.$ref !== 'string') throw new Error('Invalid reference.');
      const ref = current.$ref;
      if (Object.keys(current).some(key => !['$ref', 'summary', 'description'].includes(key))) throw new Error('Reference siblings require semantic review.');
      const identity = `${context.location}\n${ref}`;
      if (visited.has(identity) || visited.size >= 64) throw new Error('External or cyclic references require review.');
      visited.add(identity);
      if (ref.startsWith('#/')) { current = pointer(context.root, ref, ref.slice(2).split('/')); continue; }
      if (ref.startsWith('#')) throw new Error('External or cyclic references require review.');
      const separator = ref.indexOf('#');
      const fragment = separator < 0 ? '' : ref.slice(separator + 1);
      if (fragment && !fragment.startsWith('/')) throw new Error('Named reference anchors require review.');
      let location = separator < 0 ? ref : ref.slice(0, separator);
      if (!refMap || !Object.keys(refMap).some(prefix => location.startsWith(prefix))) {
        try { location = new URL(location, context.location).toString(); }
        catch { location = posix.normalize(posix.join(posix.dirname(context.location), location)); }
      }
      const root = loadMapped(location, ref);
      context = contexts.get(root)!;
      current = fragment.startsWith('/') ? pointer(root, ref, fragment.slice(1).split('/')) : root;
    }
    return current;
  };
  const schemaKeys = (value: unknown): { required: string[]; optional: string[] } => {
    if (value === undefined) return { required: [], optional: [] };
    const active = new Set<Record<string, unknown>>();
    let nodes = 0;
    type Fields = { required: Set<string>; properties: Map<string, unknown>; objectType: boolean };
    type Agreed = { required: Set<string>; properties: Map<string, unknown> };
    // oneOf demands full agreement: every valid document satisfies exactly one branch, so when branches
    // describe different observable sets the per-field truth depends on which branch matched — never guess.
    const agreeIdentical = (parts: Fields[]): Agreed => {
      const first = parts[0]!;
      parts.forEach((part, index) => {
        if (index === 0) return;
        for (const name of new Set([...first.required, ...part.required])) if (first.required.has(name) !== part.required.has(name)) throw new Error(`oneOf branches disagree: '${name}' is required in branch ${first.required.has(name) ? 0 : index} but not in branch ${first.required.has(name) ? index : 0}.`);
        for (const name of new Set([...first.properties.keys(), ...part.properties.keys()])) {
          if (!first.properties.has(name) || !part.properties.has(name)) throw new Error(`oneOf branches disagree: '${name}' is declared in only one of branch 0 and branch ${index}.`);
          if (canonical(first.properties.get(name)) !== canonical(part.properties.get(name))) throw new Error(`oneOf branches disagree: '${name}' has different type definitions in branch 0 and branch ${index}.`);
        }
      });
      return { required: new Set(first.required), properties: new Map(first.properties) };
    };
    // anyOf is sound per field: a field required in EVERY branch is always present; a field declared
    // identically in every branch is only sound as optional; fields claimed by some branches are dropped;
    // and a field two branches type differently is an observable disagreement, never a silent drop.
    const agreeIntersection = (parts: Fields[]): Agreed => {
      const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
      for (const name of new Set(parts.flatMap(part => [...part.properties.keys()]))) {
        const declaring = parts.filter(part => part.properties.has(name));
        if (declaring.length > 1 && declaring.some(part => !same(part.properties.get(name), declaring[0]!.properties.get(name)))) throw new Error(`anyOf branches disagree: '${name}' has different type definitions across branches.`);
      }
      const first = parts[0]!;
      return {
        required: new Set([...first.required].filter(name => parts.every(part => part.required.has(name)))),
        properties: new Map([...first.properties].filter(([name, definition]) => parts.every(part => same(part.properties.get(name), definition)))),
      };
    };
    const visit = (input: unknown, depth: number, inComposition: boolean): Fields => {
      if (++nodes > 512 || depth > 64) throw new Error('Schema composition exceeds the analysis budget.');
      const schema = resolve(input);
      if (active.has(schema)) throw new Error('Cyclic schema composition requires review.');
      active.add(schema);
      try {
        // Conditional schemas keep demanding semantic review in this slice; alternatives converge below.
        if (['not', 'if', 'then', 'else', 'dependentRequired', 'dependentSchemas', 'dependencies'].some(key => Object.hasOwn(schema, key))) throw new Error('Conditional schemas require semantic review.');
        if (schema.type !== undefined && schema.type !== 'object') throw new Error('Only object payload schemas are imported.');
        if (schema.nullable === true) throw new Error('Nullable object requirements require review.');
        const composed = inComposition || Object.hasOwn(schema, 'allOf');
        if (composed) {
          const supported = ['type', 'properties', 'required', 'allOf', 'oneOf', 'anyOf', 'title', 'description', 'example', 'examples', 'deprecated', 'additionalProperties'];
          if (Object.keys(schema).some(key => !supported.includes(key)) || (schema.additionalProperties !== undefined && schema.additionalProperties !== true)) throw new Error('Closed or constrained composed objects require semantic review.');
        }
        const fields: Fields = { required: new Set(stringArray(schema.required ?? [])), properties: new Map(Object.entries(object(schema.properties ?? {}))), objectType: schema.type === 'object' };
        if (composed) for (const definition of fields.properties.values()) {
          const property = resolve(definition);
          if (property.readOnly === true || property.writeOnly === true) throw new Error('Directional properties require review.');
        }
        if (Object.hasOwn(schema, 'allOf')) {
          const branches = array(schema.allOf);
          if (!branches.length || branches.length > 64) throw new Error('allOf requires 1-64 branches.');
          // Presence obligations are conjunctive. Do not merge incompatible property
          // definitions or closed objects as if allOf were inheritance.
          for (const branch of branches) {
            const child = visit(branch, depth + 1, true);
            fields.objectType ||= child.objectType;
            for (const name of child.required) fields.required.add(name);
            for (const [name, definition] of child.properties) {
              if (fields.properties.has(name) && canonical(fields.properties.get(name)) !== canonical(definition)) throw new Error('Overlapping allOf property definitions require review.');
              fields.properties.set(name, definition);
            }
          }
        }
        for (const kind of ['oneOf', 'anyOf'] as const) {
          if (!Object.hasOwn(schema, kind)) continue;
          const branches = array(schema[kind]);
          // Same branch-count and per-payload visit budgets as allOf: convergence never escapes them.
          if (!branches.length || branches.length > 64) throw new Error(`${kind} requires 1-64 branches.`);
          const parts = branches.map(branch => visit(branch, depth + 1, true));
          if (!parts.every(part => part.objectType)) throw new Error(`${kind} branches require object payloads.`);
          const agreed = kind === 'oneOf' ? agreeIdentical(parts) : agreeIntersection(parts);
          // Sibling constraints apply conjunctively to the alternative's agreed set.
          for (const name of agreed.required) fields.required.add(name);
          for (const [name, definition] of agreed.properties) {
            if (fields.properties.has(name) && canonical(fields.properties.get(name)) !== canonical(definition)) throw new Error(`${kind} branches disagree: '${name}' conflicts with sibling property definitions.`);
            fields.properties.set(name, definition);
          }
          fields.objectType ||= true;
        }
        return fields;
      } finally { active.delete(schema); }
    };
    const fields = visit(value, 0, false);
    if (Object.hasOwn(resolve(value), 'allOf') && !fields.objectType) throw new Error('Composed payloads require an explicit object type.');
    const required = [...fields.required].sort();
    return { required, optional: [...fields.properties.keys()].filter(key => !fields.required.has(key)).sort() };
  };
  const contentSchema = (value: unknown): unknown => {
    const content = object(value ?? {});
    const media = content['application/json'];
    if (!media && Object.keys(content).length) throw new Error('Non-JSON media types require review.');
    return media ? object(media).schema : undefined;
  };
  for (const [path, rawPath] of Object.entries(object(document.paths))) {
    let pathItem: Record<string, unknown>;
    try { pathItem = resolve(rawPath); }
    catch (error) { result.unresolved.push({ reference: path, reason: errorMessage(error) }); continue; }
    for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      if (!Object.hasOwn(pathItem, method)) continue;
      const reference = `${sourceReference}#/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method}`;
      try {
        const operation = resolve(pathItem[method]);
        const pathTemplate = path.split('/').map(segment => {
          if (/^\{[^{}]+\}$/.test(segment)) return `:${segment.slice(1, -1)}`;
          if (/[{}]/.test(segment)) throw new Error('Embedded path parameters require review.');
          return segment;
        }).join('/');
        const parameters = new Map<string, Record<string, unknown>>();
        for (const item of [...array(pathItem.parameters ?? []), ...array(operation.parameters ?? [])]) {
          const parameter = resolve(item);
          if (typeof parameter.name !== 'string' || typeof parameter.in !== 'string') throw new Error('Invalid parameter.');
          parameters.set(`${parameter.in}:${parameter.name}`, parameter);
        }
        const pathParams: HttpEndpointInvariant['pathParams'] = {}, requiredQuery: string[] = [], optionalQuery: string[] = [];
        for (const parameter of parameters.values()) {
          const name = parameter.name as string;
          if (parameter.in === 'path') {
            const schema = resolve(parameter.schema ?? {});
            pathParams[name] = { type: schema.format === 'uuid' ? 'uuid' : schema.type === 'integer' || schema.type === 'number' ? 'number' : 'string', ...(typeof schema.pattern === 'string' ? { pattern: schema.pattern } : {}) };
          } else if (parameter.in === 'query') (parameter.required === true ? requiredQuery : optionalQuery).push(name);
          else throw new Error('Header and cookie requirements need an explicit security-aware adapter.');
        }
        const request = operation.requestBody ? resolve(operation.requestBody) : undefined;
        const payload = schemaKeys(request ? contentSchema(request.content) : undefined);
        if (request && request.required !== true && payload.required.length) throw new Error('Conditional requirements in an optional request body need review.');
        const responses = object(operation.responses), statuses: number[] = [], requiredResponses: string[][] = [];
        for (const [status, responseValue] of Object.entries(responses)) {
          if (/^[1-5]\d\d$/.test(status)) statuses.push(Number(status));
          else if (/^[1-5]XX$/.test(status)) for (let code = Number(status[0]) * 100; code < (Number(status[0]) + 1) * 100; code++) statuses.push(code);
          else throw new Error('Default or unrecognized response status requires review.');
          const response = resolve(responseValue);
          requiredResponses.push(schemaKeys(contentSchema(response.content)).required);
        }
        if (!statuses.length) throw new Error('Operation has no explicit response statuses.');
        const value = HttpEndpointInvariantSchema.parse({ pathTemplate, pathParams, method: method.toUpperCase(), queryParams: { required: requiredQuery, optional: optionalQuery, ignored: [] },
          payloadRequirements: { observedAlwaysFields: [], observedSometimesFields: [], requiredFields: payload.required, optionalFields: payload.optional, ignoredVolatileFields: [] },
          responseExpectations: { allowedStatusCodes: statuses, bodyShapeRequiredKeys: requiredResponses[0]?.filter(key => requiredResponses.every(keys => keys.includes(key))) ?? [] }, causalDependencies: { afterOperationIds: [] },
        }) as HttpEndpointInvariant;
        result.invariants.push({ id: `openapi-${method}-${result.invariants.length}`, value, enforcement: 'WARNING', evidenceTrail: [{ source: 'OPENAPI', evidenceConfidenceHeuristic: 1, sourceReference: reference }] });
      } catch (error) { result.unresolved.push({ reference, reason: errorMessage(error) }); }
    }
  }
  return result;
}

/** Test suites export explicit assertions; test names/text are never mined as requirements. */
export function importExistingTestEvidence(input: unknown, sourceReference: string): ImportedHttpEvidence {
  if (!sourceReference.trim()) throw new Error('Evidence requires source provenance.');
  const result: ImportedHttpEvidence = { invariants: [], unresolved: [] };
  for (const [index, value] of array(input).entries()) {
    const reference = `${sourceReference}#${index}`;
    try {
      const item = object(value);
      if (typeof item.testId !== 'string' || !item.testId.trim() || item.passed !== true) throw new Error('Test evidence requires an identified passing test.');
      if (Object.keys(item).some(key => !['testId', 'passed', 'network'].includes(key))) throw new Error('Unknown test evidence field.');
      result.invariants.push({ id: `test-${index}`, value: HttpEndpointInvariantSchema.parse(item.network) as HttpEndpointInvariant, enforcement: 'WARNING', evidenceTrail: [{ source: 'EXISTING_TESTS', evidenceConfidenceHeuristic: 1, sourceReference: `${sourceReference}#${item.testId}` }] });
    } catch (error) { result.unresolved.push({ reference, reason: errorMessage(error) }); }
  }
  return result;
}

export interface HarImportOptions {
  /** Private roots the evidence must never reference. Always combined with the private state base dir, matching the OpenAPI importer. */
  privateRoots?: string[];
}

/**
 * Imports a bounded HAR 1.2 capture as observational HTTP evidence. Nothing is ever fetched.
 * Cookies and Authorization/cookie headers are never read into invariants (their presence is a
 * review finding). Only JSON request/response bodies contribute shape, and only as structural
 * field names — observed values never enter the evidence.
 */
export function importHar(input: unknown, sourceReference: string, options: HarImportOptions = {}): ImportedHttpEvidence {
  if (!sourceReference.trim()) throw new Error('Evidence requires source provenance.');
  // String captures are size-capped before parse; object inputs use entry-count and per-body budgets
  // so a 10000-entry capture is limited by count, while a single oversized body is still refused.
  if (typeof input === 'string' && Buffer.byteLength(input, 'utf8') > 4_194_304) throw new Error('HAR input exceeds the size budget.');
  const document = object(typeof input === 'string' ? JSON.parse(input) : input);
  const entries = array(object(document.log).entries);
  if (entries.length > 10000) throw new Error('HAR entries exceed the budget.');
  for (const item of entries) {
    for (const part of [object(item).request, object(item).response]) {
      const text = object(object(part).content ?? object(part).postData ?? {}).text;
      if (typeof text === 'string' && Buffer.byteLength(text, 'utf8') > 4_194_304) throw new Error('HAR input exceeds the size budget.');
    }
  }
  const privateRoots = [privateBaseDir(), ...(options.privateRoots ?? [])].flatMap(root => {
    const resolved = resolvePath(root);
    try { return [resolved, realpathSync(resolved)]; } catch { return [resolved]; }
  });
  /** Filesystem spellings of a path, including realpath of the parent when the leaf does not exist yet. */
  const pathSpellings = (candidate: string): string[] => {
    const out = new Set<string>([candidate]);
    const resolved = resolvePath(candidate);
    out.add(resolved);
    try { out.add(realpathSync(resolved)); } catch {
      try { out.add(join(realpathSync(dirname(resolved)), basename(resolved))); } catch { /* keep */ }
    }
    return [...out];
  };
  const isPrivatePath = (candidate: string): boolean => pathSpellings(candidate).some(spelling =>
    spelling.split(/[\\/]/).includes('.migration-private')
    || privateRoots.some(root => spelling === root || spelling.startsWith(root + sep)));
  // Refusals cover the private artifact domain wherever a capture mentions it: provenance strings,
  // file: URLs and URL paths carrying a .migration-private segment. HTTP(S) URLs are never fetched.
  const isPrivateRef = (value: string): boolean => {
    const normalized = value.replace(/\\/g, '/');
    if (normalized.split('/').includes('.migration-private')) return true;
    if (/^file:/i.test(value)) {
      try { return isPrivatePath(fileURLToPath(value)); }
      catch { return isPrivatePath(value.replace(/^file:\/\//i, '')); }
    }
    // Drive-letter and plain filesystem paths (including Windows `C:/...`) are not http(s) URLs.
    if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/')) return isPrivatePath(value);
    try {
      const url = new URL(value);
      return url.protocol === 'file:' ? isPrivatePath(fileURLToPath(url)) : false;
    } catch {
      return isPrivatePath(value);
    }
  };
  if (isPrivateRef(sourceReference)) throw new Error('Evidence provenance cannot reference a private root.');
  const result: ImportedHttpEvidence = { invariants: [], unresolved: [] };
  const sensitiveHeader = /^(?:authorization|cookie|set-cookie)$/i;
  const hasSensitiveMaterial = (request: Record<string, unknown>, response: Record<string, unknown> | undefined): boolean => {
    for (const cookies of [request.cookies, response?.cookies]) if (Array.isArray(cookies) && cookies.length > 0) return true;
    for (const headers of [request.headers, response?.headers]) {
      if (!Array.isArray(headers)) continue;
      for (const item of headers) {
        const header = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : undefined;
        if (header && typeof header.name === 'string' && sensitiveHeader.test(header.name)) return true;
      }
    }
    return false;
  };
  type JsonShape = { fields?: string[]; invalid?: boolean };
  const jsonShape = (value: unknown): JsonShape => {
    const body = object(value);
    if (typeof body.mimeType !== 'string' || !/json/i.test(body.mimeType) || typeof body.text !== 'string' || !body.text.trim()) return {};
    let parsed: unknown;
    try { parsed = JSON.parse(body.text); } catch { return { invalid: true }; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return { fields: Object.keys(parsed).sort() };
  };
  type EntryObservation = { index: number; method: HttpEndpointInvariant['method']; pathname: string; queryNames: string[]; status?: number; requestFields?: string[]; responseFields?: string[] };
  const observations: EntryObservation[] = [];
  for (const [index, value] of entries.entries()) {
    const reference = `${sourceReference}#log.entries[${index}]`;
    try {
      const entry = object(value);
      const request = object(entry.request);
      if (typeof request.method !== 'string' || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method.toUpperCase())) throw new Error('Unsupported HTTP method requires review.');
      const method = request.method.toUpperCase() as HttpEndpointInvariant['method'];
      if (typeof request.url !== 'string' || !request.url.trim()) throw new Error('HAR request requires a URL.');
      if (isPrivateRef(request.url)) throw new Error('HAR entry references a private root.');
      let parsedUrl: URL;
      try { parsedUrl = new URL(request.url); } catch { throw new Error('HAR request URL is not parseable.'); }
      const response = entry.response === undefined ? undefined : object(entry.response);
      if (hasSensitiveMaterial(request, response)) result.unresolved.push({ reference, reason: 'Cookies and Authorization headers require a security-aware adapter.' });
      const requestShape = request.postData === undefined ? {} : jsonShape(request.postData);
      const responseShape = response?.content === undefined ? {} : jsonShape(response.content);
      if (requestShape.invalid || responseShape.invalid) result.unresolved.push({ reference, reason: 'JSON body does not parse; request/response shape requires review.' });
      const queryNames = Array.isArray(request.queryString)
        ? request.queryString.map(item => {
            const param = object(item);
            if (typeof param.name !== 'string') throw new Error('Invalid query string entry.');
            return param.name;
          })
        : [...parsedUrl.searchParams.keys()];
      let status: number | undefined;
      if (response !== undefined) {
        if (typeof response.status !== 'number' || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw new Error('HAR response status is invalid.');
        status = response.status;
      }
      observations.push({
        index, method, pathname: parsedUrl.pathname, queryNames: [...new Set(queryNames)].sort(),
        ...(status === undefined ? {} : { status }),
        ...(requestShape.fields ? { requestFields: requestShape.fields } : {}),
        ...(responseShape.fields ? { responseFields: responseShape.fields } : {}),
      });
    } catch (error) { result.unresolved.push({ reference, reason: errorMessage(error) }); }
  }
  const order: string[] = [];
  const groups = new Map<string, EntryObservation[]>();
  for (const observation of observations) {
    const key = `${observation.method}:${observation.pathname}`;
    const group = groups.get(key);
    if (group) group.push(observation);
    else { groups.set(key, [observation]); order.push(key); }
  }
  for (const key of order) {
    const group = groups.get(key)!;
    const first = group[0]!;
    const requestPresence = new Map<string, number>(), responsePresence = new Map<string, number>(), queryPresence = new Map<string, number>();
    const statuses = new Set<number>();
    for (const observation of group) {
      if (observation.status !== undefined) statuses.add(observation.status);
      for (const field of observation.requestFields ?? []) requestPresence.set(field, (requestPresence.get(field) ?? 0) + 1);
      for (const field of observation.responseFields ?? []) responsePresence.set(field, (responsePresence.get(field) ?? 0) + 1);
      for (const name of observation.queryNames) queryPresence.set(name, (queryPresence.get(name) ?? 0) + 1);
    }
    const always = (presence: Map<string, number>): string[] => [...presence].filter(([, count]) => count === group.length).map(([name]) => name).sort();
    const sometimes = (presence: Map<string, number>): string[] => [...presence].filter(([, count]) => count < group.length).map(([name]) => name).sort();
    // Observational placement: presence goes to the observed* sets and query names stay optional.
    // requiredFields is never claimed from traffic, matching the runtime miner.
    const value = HttpEndpointInvariantSchema.parse({
      pathTemplate: first.pathname,
      pathParams: {},
      method: first.method,
      queryParams: { required: [], optional: [...queryPresence.keys()].sort(), ignored: [] },
      payloadRequirements: {
        observedAlwaysFields: always(requestPresence),
        observedSometimesFields: sometimes(requestPresence),
        requiredFields: [],
        optionalFields: [],
        ignoredVolatileFields: [],
      },
      responseExpectations: { allowedStatusCodes: [...statuses].sort((a, b) => a - b), bodyShapeRequiredKeys: always(responsePresence) },
      causalDependencies: { afterOperationIds: [] },
    }) as HttpEndpointInvariant;
    result.invariants.push({
      id: `har-${first.method.toLowerCase()}-${result.invariants.length}`,
      value,
      enforcement: 'WARNING',
      evidenceTrail: [{ source: 'HAR', evidenceConfidenceHeuristic: 1, sourceReference: `${sourceReference}#log.entries[${first.index}]` }],
    });
  }
  return result;
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object.'); return value as Record<string, unknown>; }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error('Expected array.'); return value; }
function stringArray(value: unknown): string[] { const items = array(value); if (items.some(item => typeof item !== 'string')) throw new Error('Expected string array.'); return items as string[]; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
