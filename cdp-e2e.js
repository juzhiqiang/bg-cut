// CDP 端到端验证: 上传图片 → 模型加载 → 推理 → 结果检查
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9335;
const URL = process.argv[2] || 'http://localhost:8977/index.html';
const OUT = process.argv[3] || 'docs/e2e-check.png';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + process.env.TEMP + '\\chrome-cdp-' + Date.now(),
  '--disable-http-cache',
  '--enable-unsafe-swiftshader',
  '--enable-features=WebGPU',
  'about:blank',
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
  const listeners = {};
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++msgId; pending[id] = resolve;
    ws.send(JSON.stringify({ id, method, params }));
  });
  const on = (method, fn) => { (listeners[method] = listeners[method] || []).push(fn); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending[m.id]) { pending[m.id](m.result); delete pending[m.id]; }
    else if (m.method && listeners[m.method]) listeners[m.method].forEach(fn => fn(m.params));
  };
  await new Promise(r => ws.onopen = r);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL });
  await sleep(3500);

  const logs = [];
  on('Runtime.consoleAPICalled', (p) => logs.push('[console] ' + p.args.map(a => a.value || a.description || '').join(' ')));
  on('Runtime.exceptionThrown', (p) => logs.push('[exception] ' + (p.exceptionDetails.text || '') + ' ' + (p.exceptionDetails.exception ? p.exceptionDetails.exception.description : '')));
  on('Log.entryAdded', (p) => { if (p.entry.level === 'error') logs.push('[log-error] ' + p.entry.text); });

  const gpuInfo = await send('Runtime.evaluate', {
    expression: `(async () => { try { const a = await navigator.gpu.requestAdapter(); return a ? 'WebGPU-OK' : 'WebGPU-NONE'; } catch(e){ return 'WebGPU-ERR:'+e.message; } })()`,
    awaitPromise: true, returnByValue: true,
  });
  console.log('GPU:', gpuInfo.result.value);

  const testImg = process.argv[4];
  if (!testImg) { console.log('no test image'); ws.close(); chrome.kill(); process.exit(0); }
  const b64 = fs.readFileSync(testImg).toString('base64');
  const mime = testImg.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const ext = testImg.split('.').pop();
  const injected = await send('Runtime.evaluate', {
    expression: `(async () => {
      const res = await fetch('data:${mime};base64,${b64}');
      const blob = await res.blob();
      const file = new File([blob], 'test-img.${ext}', { type: '${mime}' });
      const input = document.getElementById('fileInput');
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return 'injected';
    })()`,
    awaitPromise: true, returnByValue: true,
  });
  console.log('inject:', injected.result.value);

  let result = null;
  for (let i = 0; i < 240; i++) {
    await sleep(1000);
    const r = await send('Runtime.evaluate', {
      expression: `(() => {
        const cv = document.getElementById('canvasResult');
        const meta = document.getElementById('metaResult').textContent;
        const dl = document.getElementById('btnDownload');
        const stages = document.getElementById('stgInfer');
        const stgTxt = stages ? stages.querySelector('.txt').textContent : '';
        return JSON.stringify({ done: cv && !cv.hidden && cv.width > 0, w: cv ? cv.width : 0, h: cv ? cv.height : 0, meta, dlDisabled: dl ? dl.disabled : true, stgTxt });
      })()`,
      returnByValue: true,
    });
    const v = JSON.parse(r.result.value);
    if (i % 10 === 0) console.log(`  t=${i}s state=${v.stgTxt || (v.done ? 'done' : 'working')}`);
    if (v.done) { result = v; break; }
    const t = await send('Runtime.evaluate', { expression: `document.getElementById('toast').textContent`, returnByValue: true });
    if (t.result.value) { result = { error: t.result.value }; break; }
  }

  if (result) {
    if (result.error) { console.log('RESULT: ERROR -', result.error); }
    else { console.log('RESULT: OK', JSON.stringify(result)); }
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
    console.log('screenshot saved:', OUT);
  } else {
    console.log('RESULT: TIMEOUT');
  }
  console.log('LOGS:\n' + logs.join('\n'));
  ws.close(); chrome.kill(); process.exit(result && !result.error ? 0 : 1);
}
main().catch(e => { console.error(e); chrome.kill(); process.exit(1); });
