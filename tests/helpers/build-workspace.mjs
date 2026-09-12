import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';

export async function write(root, path, content) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}
export async function listen(port = 0) {
  const server = createServer((_, response) => response.end('unrelated'));
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  return server;
}
export const close = server => new Promise((done, reject) => {
  server.close(error => error ? reject(error) : done()); server.closeAllConnections();
});
export const buildScript = `import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('dist', {recursive:true});
writeFileSync('dist/index.html', '<!doctype html><html lang="en"><head><title>Build fixture</title></head><body><button>Save</button><output>Ready</output><script src="/app.js"></script></body></html>');
writeFileSync('dist/app.js', 'document.querySelector("button").onclick=()=>document.querySelector("output").textContent="Saved";');
writeFileSync('dist/app.js.map', '{}');`;

export async function buildWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'build-servers-'));
  const sourcePort = await listen(), targetPort = await listen();
  const sourceUrl = `http://127.0.0.1:${sourcePort.address().port}`;
  const targetUrl = `http://127.0.0.1:${targetPort.address().port}`;
  await close(sourcePort); await close(targetPort);
  for (const side of ['source', 'target']) {
    await write(root, `${side}/main.ts`, 'export const value = 1;\n');
    await write(root, `${side}/build.mjs`, buildScript);
  }
  const project = (side, baseUrl) => ({ root: side, baseUrl, relevantFiles: ['main.ts', 'build.mjs'],
    commands: [{ id: 'build', kind: 'build', argv: [process.execPath, 'build.mjs'], cwd: '.', timeoutMs: 3000 }],
    build: { commandId: 'build', outputDir: 'dist', cleanOutput: true },
  });
  const config = {
    kind: 'MIGRATION_CONFIG', version: '1', migrationId: 'served-builds',
    source: project('source', sourceUrl), target: { ...project('target', targetUrl), writePaths: ['page.tsx'], protectedPaths: [] },
    scenarios: [{ definition: { scenarioId: 'boot', unitId: 'page', name: 'Boot', description: 'Synthetic build fixture',
      entryUrl: `${sourceUrl}/`, preconditions: {}, steps: [], testDataProfile: 'standard' }, required: true,
      fixtureRoot: 'fixtures', bindings: { source: { entryUrl: `${sourceUrl}/`, steps: [] }, target: { entryUrl: `${targetUrl}/`, steps: [] } } }],
    checks: ['source', 'target'].map(side => ({ id: `build-${side}`, side, commandId: 'build', required: true })),
    requirements: [], acceptedDifferences: [], policy: {}, reset: { kind: 'ISOLATED_FIXTURES' },
    environment: { browser: 'chromium', locale: 'pt-BR', viewport: { width: 1280, height: 720 } },
    limits: { sourceRuns: 2, maxRepairAttempts: 3, maxDurationMs: 15000 },
  };
  return { root, config };
}
