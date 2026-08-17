// Upload remaining bg-cut-site files to GitHub via Contents API (Node 22 fetch)
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(process.env.USERPROFILE, '.openclaw-autoclaw', 'workspace', 'bg-cut-site');
const REPO = 'juzhiqiang/bg-cut';

// Get token
const cred = execSync('git credential fill', { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf-8' });
const token = cred.split('\n').find(l => l.startsWith('password=')).replace('password=', '');

async function listRepo(dir) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${dir}`, {
    headers: { 'Authorization': 'Bearer ' + token, 'User-Agent': 'bg-cut' }
  });
  if (!r.ok) return [];
  const d = await r.json();
  return d.map(f => f.name);
}

async function upload(rel, data) {
  const b64 = Buffer.from(data).toString('base64');
  const body = JSON.stringify({ message: 'deploy: ' + rel, content: b64 });
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${rel}`, {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'User-Agent': 'bg-cut' },
      body
    });
    if (r.ok) return 'ok';
    if (r.status === 422) return 'exists';
    const txt = await r.text();
    if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue; }
    return `HTTP ${r.status}: ${txt.slice(0, 120)}`;
  }
}

async function main() {
  const existingJs = await listRepo('js');
  const existingRoot = await listRepo('');
  console.log('existing js:', existingJs.length, 'root:', existingRoot.length);

  const allFiles = [];
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else allFiles.push(full);
    }
  }
  walk(ROOT);

  const skip = new Set(['.gitignore', 'cdp-check.js', 'cdp-diag.js', 'cdp-e2e.js', 'cdp-mobile.js', 'deploy_gh.py', 'deploy_gh2.py', 'index.html', 'server.log', 'bench.log']);
  let ok = 0, fail = 0;
  for (const f of allFiles) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    if (skip.has(path.basename(rel))) continue;
    const parent = rel.split('/')[0];
    const name = path.basename(rel);
    if (parent === 'js' && existingJs.includes(name)) { console.log('SKIP', rel); continue; }
    if (parent === 'docs') continue; // docs already uploaded
    if (existingRoot.includes(name)) { console.log('SKIP', rel); continue; }

    const data = fs.readFileSync(f);
    const status = await upload(rel, data);
    const mark = status === 'ok' || status === 'exists' ? 'OK' : 'FAIL';
    console.log(`${mark} ${rel} (${(data.length / 1024).toFixed(0)}KB) ${status}`);
    if (mark === 'FAIL') fail++;
    else ok++;
    await new Promise(r => setTimeout(r, 500)); // rate limit
  }
  console.log(`\nDone: ${ok} uploaded, ${fail} failed`);
}
main().catch(e => { console.error(e); process.exit(1); });
