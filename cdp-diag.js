// 诊断: 跑完 e2e 后读取 canvasResult 的像素统计
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9336;
const URL = process.argv[2] || 'http://localhost:8977/index.html';
const testImg = process.argv[3];

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
  const target = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'PUT', path: '/json/new?' + encodeURIComponent(URL) }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.end();
  });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let msgId = 0; const pending = {};
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++msgId; pending[id] = resolve;
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending[m.id]) { pending[m.id](m.result); delete pending[m.id]; } };
  await new Promise(r => ws.onopen = r);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: URL });
  await sleep(3000);

  const b64 = fs.readFileSync(testImg).toString('base64');
  const mime = testImg.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const ext = testImg.split('.').pop();
  await send('Runtime.evaluate', {
    expression: `(async () => {
      const res = await fetch('data:${mime};base64,${b64}');
      const blob = await res.blob();
      const file = new File([blob], 'test-img.${ext}', { type: '${mime}' });
      const input = document.getElementById('fileInput');
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })()`,
    awaitPromise: true, returnByValue: true,
  });

  // 等结果
  for (let i = 0; i < 180; i++) {
    await sleep(1000);
    const r = await send('Runtime.evaluate', {
      expression: `(() => { const cv = document.getElementById('canvasResult'); return cv && !cv.hidden && cv.width>0; })()`,
      returnByValue: true,
    });
    if (r.result.value) break;
  }

  // 统计 alpha 分布 (用 state.alpha)
  const stats = await send('Runtime.evaluate', {
    expression: `(() => {
      const a = window.__alpha || null;
      const cv = document.getElementById('canvasResult');
      const ctx = cv.getContext('2d');
      const d = ctx.getImageData(0,0,cv.width,cv.height).data;
      let n=0, sum=0, bins=[0,0,0,0,0,0,0,0,0,0];
      for(let i=3;i<d.length;i+=4){ sum+=d[i]; n++; bins[Math.min(9,Math.floor(d[i]/25.6))]++; }
      // 中心 vs 边缘 alpha
      const cx=cv.width>>1, cy=cv.height>>1;
      const center = d[(cy*cv.width+cx)*4+3];
      const corner = d[3];
      return JSON.stringify({w:cv.width,h:cv.height,meanAlpha:(sum/n).toFixed(2),bins,centerAlpha:center,cornerAlpha:corner});
    })()`,
    returnByValue: true,
  });
  console.log('STATS:', stats.result.value);

  // 保存结果 canvas 为 PNG (base64 → 文件)
  const shot = await send('Runtime.evaluate', {
    expression: `(() => { const cv = document.getElementById('canvasResult'); return cv.toDataURL('image/png'); })()`,
    returnByValue: true,
  });
  const b64out = shot.result.value.split(',')[1];
  fs.writeFileSync('docs/e2e-alpha.png', Buffer.from(b64out, 'base64'));
  console.log('saved docs/e2e-alpha.png');

  // 也保存原图 canvas
  const shot2 = await send('Runtime.evaluate', {
    expression: `(() => { const cv = document.getElementById('canvasOrig'); return cv.toDataURL('image/png'); })()`,
    returnByValue: true,
  });
  fs.writeFileSync('docs/e2e-orig.png', Buffer.from(shot2.result.value.split(',')[1], 'base64'));
  console.log('saved docs/e2e-orig.png');

  ws.close(); chrome.kill(); process.exit(0);
}
main().catch(e => { console.error(e); chrome.kill(); process.exit(1); });
