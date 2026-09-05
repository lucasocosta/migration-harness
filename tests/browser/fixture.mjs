import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { transformAngularComponent } from '../../packages/codemods/dist/index.js';

export async function frameworkFixture() {
  const root = resolve('examples/angular-react-pilot');
  const source = await readFile(resolve(root, 'source/customer-profile.ts'), 'utf8');
  const transformed = transformAngularComponent(source, 'CustomerProfileComponent', 'customer-profile.ts');
  const options = { bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2016', logLevel: 'silent', tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } } };
  const angular = await build({ ...options, entryPoints: [resolve(root, 'source/main.ts')] });
  const compileTarget = async code => (await build({ ...options, stdin: { contents: code + "\nimport { createRoot } from 'react-dom/client';\ncreateRoot(document.querySelector('harness-root')).render(<CustomerProfileComponent />);", resolveDir: resolve('.'), sourcefile: 'candidate.tsx', loader: 'tsx' } })).outputFiles[0].text;
  let targetBundle = await compileTarget(transformed.code);
  const start = async kind => {
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/api/customers/')) { res.writeHead(204); res.end(); return; }
      if (req.url === '/app.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end(kind === 'source' ? angular.outputFiles[0].text : targetBundle); return; }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Customer profile</title></head><body><harness-root></harness-root><script src="/app.js"></script></body></html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
  };
  const original = await start('source'), target = await start('target');
  return { source, transformed, sourceUrl: original.url, targetUrl: target.url,
    setTarget: async code => { targetBundle = await compileTarget(code); },
    close: async () => { await original.close(); await target.close(); },
  };
}
