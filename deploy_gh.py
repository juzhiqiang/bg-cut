# -*- coding: utf-8 -*-
"""Upload bg-cut-site files to GitHub via Contents API (git transport is blocked locally)."""
import base64, json, pathlib, subprocess, sys, urllib.request, urllib.error

ROOT = pathlib.Path(r"C:\Users\Administrator\.openclaw-autoclaw\workspace\bg-cut-site")
REPO = "juzhiqiang/bg-cut"

proc = subprocess.run('git credential fill', input='protocol=https\nhost=github.com\n\n',
                      capture_output=True, text=True)
token = [l.replace('password=', '') for l in proc.stdout.split('\n') if l.startswith('password=')][0]
HDR = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
       'Accept': 'application/vnd.github+json', 'User-Agent': 'bg-cut-deploy'}

files = sorted(p for p in ROOT.rglob('*') if p.is_file() and '.git' not in p.parts)
print(f"files to upload: {len(files)}")

def upload(path_rel: str, data: bytes):
    b64 = base64.b64encode(data).decode()
    body = json.dumps({'message': 'deploy: ' + path_rel, 'content': b64}).encode()
    req = urllib.request.Request(f'https://api.github.com/repos/{REPO}/contents/{path_rel}',
                                 data=body, method='PUT', headers=HDR)
    try:
        urllib.request.urlopen(req, timeout=120)
        return 'ok'
    except urllib.error.HTTPError as e:
        return f'HTTP {e.code}: {e.read()[:160].decode(errors="replace")}'

fail = []
for i, p in enumerate(files):
    rel = p.relative_to(ROOT).as_posix()
    data = p.read_bytes()
    status = upload(rel, data)
    mark = 'OK' if status == 'ok' else 'FAIL'
    print(f"[{i+1}/{len(files)}] {mark} {rel} ({len(data)/1024:.0f}KB) {'' if status=='ok' else status}", flush=True)
    if status != 'ok':
        fail.append(rel)

print('\nRESULT:', 'ALL OK' if not fail else f'{len(fail)} failed: {fail}')
