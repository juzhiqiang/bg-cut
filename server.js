// 极简静态服务器: node server.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');
const port = parseInt(process.argv[2] || '8899', 10);
const root = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
  '.json': 'application/json', '.onnx': 'application/octet-stream',
  '.md': 'text/markdown; charset=utf-8', '.ico': 'image/x-icon',
};
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = path.join(root, p);
  if (!fp.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'Content-Length': data.length });
    res.end(data);
  });
}).listen(port, () => console.log(`server on http://127.0.0.1:${port}`));
