import { HttpEndpointInvariantSchema, type HttpEndpointInvariant, type Invariant } from '@migration-harness/core';

export interface ImportedHttpEvidence {
  invariants: Invariant<HttpEndpointInvariant>[];
  unresolved: Array<{ reference: string; reason: string }>;
}

/** Imports a bounded OpenAPI 3.0/3.1 subset without fetching external references. */
export function importOpenApi(input: unknown, sourceReference: string): ImportedHttpEvidence {
  const document = object(input);
  if (typeof document.openapi !== 'string' || !/^3\.[01]\./.test(document.openapi)) throw new Error('OpenAPI 3.0 or 3.1 is required.');
  if (!sourceReference.trim()) throw new Error('Evidence requires source provenance.');
  const result: ImportedHttpEvidence = { invariants: [], unresolved: [] };
  const resolve = (value: unknown): Record<string, unknown> => {
    let current = object(value);
    const visited = new Set<string>();
    while (typeof current.$ref === 'string') {
      const ref = current.$ref;
      if (!ref.startsWith('#/') || visited.has(ref) || visited.size >= 64) throw new Error('External or cyclic references require review.');
      visited.add(ref);
      let target: unknown = document;
      for (const token of ref.slice(2).split('/').map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'))) {
        const record = object(target);
        if (!Object.hasOwn(record, token) || ['__proto__', 'constructor', 'prototype'].includes(token)) throw new Error(`Unresolved reference ${ref}`);
        target = record[token];
      }
      current = object(target);
    }
    return current;
  };
  const schemaKeys = (value: unknown): { required: string[]; optional: string[] } => {
    if (value === undefined) return { required: [], optional: [] };
    const schema = resolve(value);
    if (['allOf', 'oneOf', 'anyOf', 'not', 'if'].some(key => Object.hasOwn(schema, key))) throw new Error('Composed schemas require semantic review.');
    if (schema.type && schema.type !== 'object') throw new Error('Only object payload schemas are imported.');
    const required = stringArray(schema.required ?? []);
    const properties = Object.keys(object(schema.properties ?? {}));
    return { required, optional: properties.filter(key => !required.includes(key)) };
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
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object.'); return value as Record<string, unknown>; }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error('Expected array.'); return value; }
function stringArray(value: unknown): string[] { const items = array(value); if (items.some(item => typeof item !== 'string')) throw new Error('Expected string array.'); return items as string[]; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
