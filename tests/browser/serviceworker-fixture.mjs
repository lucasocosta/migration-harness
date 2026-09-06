import { createServer } from 'node:http';

/** Trivial real service worker: install -> skipWaiting, activate -> claim pages, fetch -> passthrough for /api/*. */
const SW_SOURCE = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (new URL(event.request.url).pathname.startsWith('/api/')) event.respondWith(fetch(event.request));
});
`;

/** Dependency-free service-worker fixture (same shape as websocket-fixture.mjs): serves a page that registers /sw.js
 *  and a fetch-triggering button. All server-side requests are logged so "never registered" is observable, not inferred. */
export async function serviceWorkerFixture() {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/sw.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end(SW_SOURCE); return; }
    if (req.url === '/api/data') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ value: 42 })); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SW</title></head><body>
<button>Fetch</button>
<script>
navigator.serviceWorker.register('/sw.js').catch(() => {});
document.querySelector('button').addEventListener('click', async () => {
  // Bound the wait for a controller: in allow mode one claims this page; in block mode registration never
  // activates (Playwright resolves register() but the worker is never fetched or installed), so the marker
  // records which outcome happened before the fetch is routed.
  const deadline = Date.now() + 8000;
  while (!navigator.serviceWorker.controller && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  localStorage.setItem(navigator.serviceWorker.controller ? 'sw-controlled' : 'sw-uncontrolled', '1');
  const response = await fetch('/api/data', { headers: { accept: 'application/json' } });
  await response.json();
  localStorage.setItem('data-loaded', '1');
});
</script></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, requests, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
