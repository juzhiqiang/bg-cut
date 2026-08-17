// CDP 验证: 强制 390px 视口 (Emulation.setDeviceMetricsOverride)
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9334;
const URL = process.argv[2] || 'http://localhost:8977/index.html';
const OUT = process.argv[3] || 'docs/cdp-mobile390.png';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + process.env.TEMP + '\\chrome-cdp-' + Date.now(),
  '--disable-http-cache', 'about:blank',
], { stdio: 'ignore' });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  let tabs = null;
  for (let i = 0; i < 40; i++) {
    try { tabs = await getJson('/json'); break; } catch (e) { await sleep(500); }
  }
  if (!tabs) { console.error('chrome not reachable'); chrome.kill(); process.exit(1); }
  const target = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'PUT', path: '/json/new?' + encodeURIComponent(URL) }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.end();
  });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = {};
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++msgId; pending[id] = resolve;
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending[m.id]) { pending[m.id](m.result); delete pending[m.id]; }
  };
  await new Promise(r => ws.onopen = r);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: URL });
  await sleep(5000);
  const expr = `(() => {
    const h1 = document.querySelector('.hero h1');
    const r = h1.getBoundingClientRect();
    const cs = getComputedStyle(h1);
    const strip = document.querySelector('.status-strip');
    const sr = strip.getBoundingClientRect();
    const sub = document.querySelector('.hero p.sub');
    const subr = sub.getBoundingClientRect();
    const upload = document.querySelector('.upload .t2');
    const ur = upload.getBoundingClientRect();
    return JSON.stringify({
      viewport: [innerWidth, innerHeight], dpr: devicePixelRatio,
      h1: [r.width, h1.scrollWidth, cs.fontSize, cs.lineHeight],
      h1TextOk: r.width >= h1.scrollWidth,
      sub: [subr.width, sub.scrollWidth], subOk: subr.width >= sub.scrollWidth,
      strip: [sr.width, strip.scrollWidth, sr.height], stripOk: sr.width >= strip.scrollWidth,
      uploadT2: [ur.width, upload.scrollWidth], uploadOk: ur.width >= upload.scrollWidth,
      bodyScrollW: document.body.scrollWidth, bodyOverflowX: document.body.scrollWidth > innerWidth,
    });
  })()`;
  const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log('LAYOUT390:', res.result.value);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('screenshot saved:', OUT);
  ws.close(); chrome.kill(); process.exit(0);
}
main().catch(e => { console.error(e); chrome.kill(); process.exit(1); });
