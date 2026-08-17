// CDP 验证脚本: 启动 headless chrome --remote-debugging-port, 查询元素渲染尺寸与截图
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const URL = process.argv[2] || 'http://localhost:8977/index.html';
const OUT = process.argv[3] || 'docs/cdp-check.png';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--window-size=390,844', '--force-device-scale-factor=1',
  '--user-data-dir=' + process.env.TEMP + '\\chrome-cdp-' + Date.now(),
  '--disable-http-cache',
  'about:blank',
], { stdio: 'ignore' });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  // wait for chrome
  let tabs = null;
  for (let i = 0; i < 40; i++) {
    try { tabs = await getJson('/json'); break; } catch (e) { await sleep(500); }
  }
  if (!tabs) { console.error('chrome not reachable'); chrome.kill(); process.exit(1); }
  // open target
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
  await sleep(1500);
  await send('Page.enable');
  await send('Runtime.enable');
  // navigate
  await send('Page.navigate', { url: URL });
  await sleep(4500);
  // query layout
  const expr = `(() => {
    const h1 = document.querySelector('.hero h1');
    const r = h1.getBoundingClientRect();
    const cs = getComputedStyle(h1);
    const strip = document.querySelector('.status-strip');
    const sr = strip.getBoundingClientRect();
    const sub = document.querySelector('.hero p.sub');
    const subr = sub.getBoundingClientRect();
    return JSON.stringify({
      viewport: [innerWidth, innerHeight],
      h1Text: h1.textContent,
      h1Width: r.width, h1ScrollW: h1.scrollWidth, h1Font: cs.fontSize,
      subText: sub.textContent,
      subWidth: subr.width, subScrollW: sub.scrollWidth,
      stripRect: [sr.width, sr.height], stripScrollH: strip.scrollHeight,
      bodyScrollW: document.body.scrollWidth,
    });
  })()`;
  const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log('LAYOUT:', res.result.value);
  // screenshot
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('screenshot saved:', OUT);
  ws.close();
  chrome.kill();
  process.exit(0);
}
main().catch(e => { console.error(e); chrome.kill(); process.exit(1); });
