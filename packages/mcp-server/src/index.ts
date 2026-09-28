import { createInterface } from 'node:readline';
import {
  prepareMigration, verifyMigration, startMigrationSession, inspectMigrationSession,
  verifyMigrationSession, updateMigrationSessionReference,
} from '@migration-harness/engine';
import { parseMigrationConfig } from '@migration-harness/core';
import { assertAgentSafe, screenResult } from './hygiene.js';

/**
 * Thin MCP stdio transport over the same engine functions the CLI uses.
 * Transport only: the harness remains the sole issuer of PASS/FAIL/INCONCLUSIVE.
 * No tool auto-applies suggestions, bindings, or policy.
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
    description: 'Verify the candidate against the fixed reference. Harness-issued PASS/FAIL/INCONCLUSIVE only.',
    inputSchema: {
      type: 'object',
      properties: {
        configPath: { type: 'string' },
        workspaceRoot: { type: 'string' },
        artifactPath: { type: 'string' },
        preparationPath: { type: 'string' },
        allowProjectCommands: { type: 'boolean' },
      },
      required: ['configPath', 'workspaceRoot', 'preparationPath'],
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

async function readConfig(path: string): Promise<unknown> {
  const { readFile } = await import('node:fs/promises');
  return parseMigrationConfig(JSON.parse(await readFile(path, 'utf8')));
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
    case 'verify_migration': {
      const { readFile } = await import('node:fs/promises');
      const preparation = JSON.parse(await readFile(String(args.preparationPath ?? ''), 'utf8'));
      return verifyMigration({
        config, workspaceRoot, artifactPath: String(args.artifactPath ?? 'artifacts'),
        preparation, allowProjectCommands: args.allowProjectCommands === true,
      });
    }
    case 'start_migration_session':
      return startMigrationSession({
        config, workspaceRoot,
        preparation: JSON.parse(await (await import('node:fs/promises')).readFile(String(args.preparationPath), 'utf8')),
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
      // verify_migration on a standard session without a preparation path is the session verify.
      return verifyMigrationSession({ config, workspaceRoot, allowProjectCommands: args.allowProjectCommands === true });
  }
}

export async function handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
  const id = request.id ?? null;
  const method = request.method ?? '';
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'migration-harness', version: '0.2.0' } } };
  }
  if (method === 'notifications/initialized' || method === 'initialized') return undefined;
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: ALL_TOOLS } };
  if (method === 'tools/call') {
    const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const name = String(params.name ?? '');
    if (!ALL_TOOLS.some(tool => tool.name === name)) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } };
    }
    try {
      const result = await callTool(name, params.arguments ?? {});
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(screenResult(result), null, 2) }] } };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'TOOL_FAILED';
      return { jsonrpc: '2.0', id, error: { code: -32000, message } };
    }
  }
  if (id === null) return undefined;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

export async function serveStdio(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      continue;
    }
    const response = await handleRequest(request);
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}
