import { createInterface } from 'node:readline';
import {
  prepareMigration, verifyMigration, startMigrationSession, inspectMigrationSession,
  verifyMigrationSession, updateMigrationSessionReference, migrationSessionPath,
} from '@migration-harness/engine';
import { parseMigrationConfig, type MigrationConfig } from '@migration-harness/core';
import { assertAgentSafe, screenResult, stableErrorMessage } from './hygiene.js';
import { readPublicJson } from './public-io.js';

/**
 * Thin MCP stdio transport over the same engine functions the CLI uses.
 * Transport only: the harness remains the sole issuer of PASS/FAIL/INCONCLUSIVE.
 * No tool auto-applies suggestions, bindings, or policy.
 * Every request envelope is runtime-validated before dispatch (id: string|number|null,
 * method: string, params: object/absent) and every complete response payload — id, result
 * and error — is hygiene-screened, so private markers, pseudonyms and raw exception text
 * never reflect back onto the channel. Malformed input answers INVALID_REQUEST and the
 * transport keeps serving.
 */

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const TOOLS = [
  {
    name: 'prepare_migration',
    description: 'Prepare a fixed migration reference. Preparation PASS is not migration success.',
    inputSchema: {
      type: 'object',
      properties: {
        configPath: { type: 'string' },
        workspaceRoot: { type: 'string' },
        artifactPath: { type: 'string' },
        allowProjectCommands: { type: 'boolean' },
      },
      required: ['configPath', 'workspaceRoot', 'artifactPath'],
    },
  },
  {
    name: 'verify_migration',
    description: 'Verify the candidate against the fixed reference. Harness-issued PASS/FAIL/INCONCLUSIVE only. A standard profile or existing session uses the session-owned reference, output and budgets.',
    inputSchema: {
      type: 'object',
      properties: {
        configPath: { type: 'string' },
        workspaceRoot: { type: 'string' },
        artifactPath: { type: 'string' },
        preparationPath: { type: 'string' },
        allowProjectCommands: { type: 'boolean' },
      },
      required: ['configPath', 'workspaceRoot'],
    },
  },
  {
    name: 'start_migration_session',
    description: 'Start a standard-profile persistent session (budgets, attempts).',
    inputSchema: {
      type: 'object',
      properties: { configPath: { type: 'string' }, workspaceRoot: { type: 'string' }, preparationPath: { type: 'string' } },
      required: ['configPath', 'workspaceRoot', 'preparationPath'],
    },
  },
  {
    name: 'inspect_migration_session',
    description: 'Session status: attempts, budget, scope, reference status.',
    inputSchema: {
      type: 'object',
      properties: { configPath: { type: 'string' }, workspaceRoot: { type: 'string' } },
      required: ['configPath', 'workspaceRoot'],
    },
  },
  {
    name: 'update_migration_session',
    description: 'Controlled reference update (coverage extension or binding adaptation). Owner-decision required for weakening.',
    inputSchema: {
      type: 'object',
      properties: {
        configPath: { type: 'string' }, workspaceRoot: { type: 'string' }, artifactPath: { type: 'string' },
        allowProjectCommands: { type: 'boolean' }, ownerDecision: { type: 'string' },
      },
      required: ['configPath', 'workspaceRoot', 'artifactPath'],
    },
  },
] as const;

const ALL_TOOLS = [
  ...TOOLS,
  {
    name: 'verify_migration_session',
    description: 'Run standard-session verification with persistent budgets.',
    inputSchema: {
      type: 'object',
      properties: { configPath: { type: 'string' }, workspaceRoot: { type: 'string' }, allowProjectCommands: { type: 'boolean' } },
      required: ['configPath', 'workspaceRoot'],
    },
  },
];

/** Caller-selected inputs are truthy, mirroring how the CLI reads its migration options. */
function callerSelected(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).length > 0;
}

async function readConfig(path: string): Promise<MigrationConfig> {
  return parseMigrationConfig(await readPublicJson(path, 'config-path'));
}

/** Same deterministic session path the CLI lstats before accepting any one-shot verification. */
async function sessionExists(config: MigrationConfig, workspaceRoot: string): Promise<boolean> {
  const { lstat } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  return lstat(resolve(workspaceRoot, migrationSessionPath(config))).then(() => true,
    (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  assertAgentSafe(args, 'tool-args');
  const workspaceRoot = String(args.workspaceRoot ?? '');
  const config = await readConfig(String(args.configPath ?? ''));
  switch (name) {
    case 'prepare_migration':
      return prepareMigration({
        config, workspaceRoot, artifactPath: String(args.artifactPath ?? ''),
        allowProjectCommands: args.allowProjectCommands === true,
      });
    case 'verify_migration':
      // CLI parity (packages/cli/src/migration.ts): the standard profile and any existing
      // session own the reference, the output and the persistent budgets; a caller-selected
      // preparation/output never reaches a standalone verifier.
      if (config.profile === 'standard') {
        if (callerSelected(args.preparationPath) || callerSelected(args.artifactPath)) throw new Error('STANDARD_SESSION_OWNS_REFERENCE_AND_OUTPUT');
        if (!await sessionExists(config, workspaceRoot)) throw new Error('STANDARD_SESSION_REQUIRED');
        return verifyMigrationSession({ config, workspaceRoot, allowProjectCommands: args.allowProjectCommands === true });
      }
      if (await sessionExists(config, workspaceRoot)) throw new Error('STANDARD_SESSION_PROFILE_REQUIRED');
      if (!callerSelected(args.preparationPath)) throw new Error('MISSING_PREPARATION_PATH');
      return verifyMigration({
        config, workspaceRoot, artifactPath: String(args.artifactPath ?? 'artifacts'),
        preparation: await readPublicJson(String(args.preparationPath), 'preparation-path', 32_000_000),
        allowProjectCommands: args.allowProjectCommands === true,
      });
    case 'start_migration_session':
      if (!callerSelected(args.preparationPath)) throw new Error('MISSING_PREPARATION_PATH');
      return startMigrationSession({
        config, workspaceRoot,
        preparation: await readPublicJson(String(args.preparationPath), 'preparation-path', 32_000_000),
      });
    case 'inspect_migration_session':
      return inspectMigrationSession({ config, workspaceRoot });
    case 'update_migration_session':
      return updateMigrationSessionReference({
        config, workspaceRoot, artifactPath: String(args.artifactPath ?? ''),
        allowProjectCommands: args.allowProjectCommands === true,
        ...(args.ownerDecision ? { ownerDecisionReference: String(args.ownerDecision) } : {}),
      });
    default:
      // Only verify_migration_session reaches the default: it never takes a caller preparation or output.
      return verifyMigrationSession({ config, workspaceRoot, allowProjectCommands: args.allowProjectCommands === true });
  }
}

/** A poisoned correlation id must not carry private markers back to the channel. */
function screenId(id: string | number | null): string | number | null {
  if (typeof id === 'string') { try { assertAgentSafe(id, 'request-id'); } catch { return null; } }
  return id;
}

/** A request that passed envelope validation. */
interface ValidEnvelope { id: string | number | null; method: string; params: unknown; }

/**
 * Runtime validation of the JSON-RPC envelope before any dispatch: `id` must be a string, a
 * number or null (anything else is an invalid request whose id must never be reflected),
 * `method` must be a string, and `params` must be a non-null object or absent. Non-object
 * and null requests fail here too, so no field access ever happens on unvalidated input.
 */
function validateEnvelope(request: unknown): ValidEnvelope | undefined {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return undefined;
  const { id, method, params } = request as { id?: unknown; method?: unknown; params?: unknown };
  if (id !== undefined && id !== null && typeof id !== 'string' && typeof id !== 'number') return undefined;
  if (typeof method !== 'string') return undefined;
  if (params !== undefined && (typeof params !== 'object' || params === null)) return undefined;
  return { id: id === undefined ? null : id as string | number | null, method, params };
}

/** Structured answer for input that never became a valid request: a fixed payload, id null. */
function invalidRequest(): JsonRpcResponse {
  return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'INVALID_REQUEST' } };
}

/**
 * Screen the complete response payload — id, result and error — before it leaves the server.
 * Anything still carrying a private marker or a pseudonym is replaced wholesale: not one
 * field of the offending response is reflected back.
 */
function screenResponse(response: JsonRpcResponse): JsonRpcResponse {
  try { assertAgentSafe(response, 'response'); return response; }
  catch { return { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'TOOL_FAILED' } }; }
}

export async function handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
  let envelope: ValidEnvelope | undefined = undefined;
  let id: string | number | null = null;
  try {
    envelope = validateEnvelope(request);
    if (!envelope) return screenResponse(invalidRequest());
    id = screenId(envelope.id);
    const method = envelope.method;
    if (method === 'initialize') {
      return screenResponse({ jsonrpc: '2.0', id, result: screenResult({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'migration-harness', version: '0.2.0' } }) });
    }
    if (method === 'notifications/initialized' || method === 'initialized') return undefined;
    if (method === 'tools/list') return screenResponse({ jsonrpc: '2.0', id, result: screenResult({ tools: ALL_TOOLS }) });
    if (method === 'tools/call') {
      const params = (envelope.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const name = String(params.name ?? '');
      // The requested name is caller input: a generic structured error, never a reflection.
      if (!ALL_TOOLS.some(tool => tool.name === name)) return screenResponse({ jsonrpc: '2.0', id, error: { code: -32602, message: 'UNKNOWN_TOOL' } });
      const result = await callTool(name, params.arguments ?? {});
      return screenResponse({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(screenResult(result), null, 2) }] } });
    }
    if (id === null) return undefined;
    return screenResponse({ jsonrpc: '2.0', id, error: { code: -32601, message: 'METHOD_NOT_FOUND' } });
  } catch (error) {
    // Nothing reaches dispatch without validation, so an envelope that never validated
    // answers INVALID_REQUEST; a validated request answers with its stable failure code.
    if (!envelope) return screenResponse(invalidRequest());
    if (envelope.method === 'notifications/initialized' || envelope.method === 'initialized') return undefined;
    return screenResponse({ jsonrpc: '2.0', id, error: { code: -32000, message: stableErrorMessage(error) } });
  }
}

export async function serveStdio(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const response = await handleRequest(JSON.parse(trimmed) as JsonRpcRequest);
      if (response) output.write(`${JSON.stringify(response)}\n`);
    } catch {
      // Unparseable lines and anything that escapes request handling answer with a
      // structured invalid-request response; serving continues on the next line.
      output.write(`${JSON.stringify(invalidRequest())}\n`);
    }
  }
}
