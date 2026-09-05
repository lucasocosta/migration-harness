import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Minimal dependency-free RFC 6455 text/binary echo server for capture tests. Pages and connection logs are observable for assertions. */
export async function webSocketFixture() {
  const connections = [];
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>WS</title></head><body>
<button>Send</button>
<script>
const path = decodeURIComponent(location.pathname);
if (path !== '/blank') {
  const target = path === '/page-limits' ? '/limits' : path === '/page-blocked' ? '/blocked' : '/live';
  const socket = new WebSocket('ws://' + location.host + target);
  window.socket = socket;
  socket.onopen = () => {
    if (target === '/live') socket.send(JSON.stringify({ hello: 'world', token: 'raw-secret' }));
    else if (target === '/limits') {
      socket.send('x'.repeat(40000));
      socket.send(new Uint8Array([1, 2, 3]));
      socket.send(JSON.stringify({ done: true }));
    } else socket.close();
  };
  socket.onerror = () => localStorage.setItem('blocked', 'yes');
  socket.onclose = () => { if (target === '/blocked') localStorage.setItem('blocked', 'yes'); };
  document.querySelector('button').addEventListener('click', () => socket.send(JSON.stringify({ second: 2 })));
}
</script></body></html>`);
  });
  server.on('upgrade', (req, socket) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${createHash('sha1').update(key + GUID).digest('base64')}\r\n\r\n`);
    const connection = { path, frames: [] };
    connections.push(connection);
    const send = (payload, opcode) => {
      const bytes = Buffer.from(payload);
      const header = bytes.length < 126 ? Buffer.from([0x80 | opcode, bytes.length])
        : bytes.length < 65536 ? Buffer.concat([Buffer.from([0x80 | opcode, 126]), (() => { const view = Buffer.alloc(2); view.writeUInt16BE(bytes.length); return view; })()])
        : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const view = Buffer.alloc(8); view.writeBigUInt64BE(BigInt(bytes.length)); return view; })()]);
      socket.write(Buffer.concat([header, bytes]));
      connection.frames.push({ direction: 'out', opcode, length: bytes.length });
    };
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let length = buffer[1] & 0x7f, offset = 2;
        if (length === 126) { length = buffer.readUInt16BE(2); offset = 4; }
        else if (length === 127) { length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (!masked) { socket.destroy(); return; }
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        buffer = buffer.subarray(offset + 4 + length);
        connection.frames.push({ direction: 'in', opcode, length: payload.length, text: opcode === 1 ? payload.toString('utf8') : undefined });
        if (opcode === 8) { send(payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0), 8); socket.end(); return; }
        if (opcode === 9) { send(payload, 10); continue; }
        send(payload, opcode);
        if (path === '/limits') setTimeout(() => { if (!socket.destroyed) send(JSON.stringify({ late: true }), 1); }, 500);
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => socket.destroy());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, connections, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
