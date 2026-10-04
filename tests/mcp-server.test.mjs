import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../packages/mcp-server/dist/index.js';
import { assertAgentSafe } from '../packages/mcp-server/dist/hygiene.js';

test('mcp initialize and tools/list expose engine tools without new verdicts', async () => {
  const init = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(init.result.serverInfo.name, 'migration-harness');
  const list = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = list.result.tools.map(tool => tool.name);
  for (const name of ['prepare_migration', 'verify_migration', 'start_migration_session', 'inspect_migration_session', 'update_migration_session', 'verify_migration_session']) {
    assert.ok(names.includes(name), name);
  }
  // The retired restricted interface is gone from the surface itself: no tool declares a
  // caller-selected preparation, in properties or among the required arguments (PLAN-V2 §8.2).
  for (const tool of list.result.tools) {
    assert.equal('preparationPath' in tool.inputSchema.properties, false, `${tool.name} declares no preparationPath`);
    assert.ok(!tool.inputSchema.required.includes('preparationPath'), `${tool.name} never requires a preparation`);
  }
  const unknown = await handleRequest({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'auto_approve', arguments: {} } });
  assert.equal(unknown.error.code, -32602);
});

test('hygiene rejects pseudonyms and private paths on the assistant channel', () => {
  assertAgentSafe({ code: 'BEHAVIOR_DIVERGENCE', detailCode: 'STEP_FAILED' });
  assert.throws(() => assertAgentSafe({ token: 'p_0123456789abcdef01234567' }), /PSEUDONYM/);
  assert.throws(() => assertAgentSafe({ path: '/home/user/.migration-private/x' }), /PRIVATE_PATH/);
  assert.throws(() => assertAgentSafe('raw at ~/.local/state/migration-harness/trace'), /PRIVATE_PATH/);
});

test('tools/call refuses args that carry raw-trace tokens before engine work', async () => {
  const response = await handleRequest({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'inspect_migration_session', arguments: { configPath: 'x.json', workspaceRoot: 'w', leak: 'p_0123456789abcdef01234567' } },
  });
  assert.match(response.error.message, /PSEUDONYM/);
});
