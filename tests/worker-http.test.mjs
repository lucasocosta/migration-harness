import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { BoundedWorker, HttpWorkerProvider, fileHash } from '../packages/llm-worker/dist/index.js';

test('HTTP worker transport handles structured patches, errors, redirects, caps and cancellation', async () => {
  const manifest = { unitId: 'unit', generatedAt: new Date().toISOString(), transformer: { kind: 'LLM', name: 'local-protocol-fixture' }, mappings: [] };
  let received;
  const server = createServer(async (req, res) => {
    if (req.url === '/hang') return;
    if (req.url === '/error') { res.writeHead(500); res.end(); return; }
    if (req.url === '/redirect') { res.writeHead(302, { location: '/ok' }); res.end(); return; }
    if (req.url === '/large') { res.end('x'.repeat(2_000_001)); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    received = { authorization: req.headers.authorization, ...JSON.parse(body) };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ patches: [{ path: 'candidate.tsx', beforeHash: fileHash(''), content: 'export const fixed = true;' }], manifest }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  const input = { plan: { unitId: 'unit', createdAt: new Date().toISOString(), items: [] }, files: { 'candidate.tsx': '' } };
  const policy = { allowedFiles: ['candidate.tsx'], allowedPackages: [], maxFiles: 1, maxInputBytes: 10000, maxOutputBytes: 10000, timeoutMs: 1000 };
  try {
    const worker = new BoundedWorker(new HttpWorkerProvider(`${root}/ok`, 'fixture-token'), policy);
    assert.equal((await worker.transform(input)).patches.length, 1); assert.equal(received.authorization, 'Bearer fixture-token'); assert.equal(typeof received.system, 'string'); assert.equal(JSON.parse(received.data).mode, 'transform');
    for (const path of ['error', 'redirect', 'large']) await assert.rejects(new BoundedWorker(new HttpWorkerProvider(`${root}/${path}`), policy).transform(input));
    await assert.rejects(new BoundedWorker(new HttpWorkerProvider(`${root}/hang`), { ...policy, timeoutMs: 50 }).transform(input), /deadline/);
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
});
