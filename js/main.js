/* 净图 JING CUT — 纯前端抠图主逻辑 */
'use strict';

/* ============ 模型源配置 ============ */
/* 主源: ModelScope (国内可达, CORS 已验) ; 备源: jsDelivr (镜像) */
const MODELS = {
  rmbg_1_4: {
    name: 'BRIA RMBG-1.4 (FP16)',
    size: '约 88MB',
    inputs: 'input',          // [1,3,1024,1024]
    norm: 'rmbg',             // mean 0.5 / std 1.0
    inferSize: 1024,
    urls: [
      'https://modelscope.cn/models/briaai/RMBG-1.4/resolve/master/onnx/model_fp16.onnx',
      'https://modelscope.cn/models/AI-ModelScope/RMBG-1.4/resolve/master/onnx/model_fp16.onnx',
    ],
    sha256: null,
  },
  rmbg_2_0: {
    name: 'BRIA RMBG-2.0 (Q4F16)',
    size: '约 234MB',
    inputs: 'pixel_values',   // [1,3,H,W] 动态尺寸
    norm: 'rmbg',
    inferSize: 2048,          // 高精档原生推理尺寸
    urls: [
      'https://modelscope.cn/models/briaai/RMBG-2.0/resolve/master/onnx/model_q4f16.onnx',
      'https://modelscope.cn/models/AI-ModelScope/RMBG-2.0/resolve/master/onnx/model_q4f16.onnx',
    ],
    sha256: null,
  },
};
/* WebGPU 可用时高精档支持 2048; CPU 时自动降为 1024 保性能 */
const MEAN = [0.5, 0.5, 0.5];
const STD = [1.0, 1.0, 1.0];

const MAX_FILE = 25 * 1024 * 1024; // 25MB
const MAX_DIM = 6000;              // 超过提示降级

const $ = (id) => document.getElementById(id);
const state = {
  model: 'rmbg_1_4',
  outSize: '1024',
  bg: 'transp',
  image: null,        // ImageBitmap
  backup: null,       // canvas 备份 (bitmap transfer 后使用)
  width: 0, height: 0,
  alpha: null,        // Float32Array (w*h)
  worker: null,
  engineReady: false,
  modelReady: false,
  busy: false,
  elapsed: 0,
};

/* ---------- toast ---------- */
let toastTimer = null;
function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 4200);
}

/* ---------- engine status ---------- */
function setStatus(id, ok, txt) {
  const el = $(id);
  if (!el) return;
  el.className = 'item ' + (ok ? 'ok' : ok === null ? '' : 'err');
  el.querySelector('span:last-child').textContent = txt;
}

/* ---------- ort + worker ---------- */
async function initEngine() {
  if (state.engineReady) return;
  setStatus('stEngine', null, '加载推理引擎…');
  let hasWebGPU = false;
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      hasWebGPU = !!adapter;
    }
  } catch (e) { /* ignore */ }
  try {
    ort.env.wasm.wasmPaths = 'js/';
    if (hasWebGPU) ort.env.wasm.numThreads = 1;
  } catch (e) { /* ignore */ }
  if (!state.worker) {
    state.worker = new Worker('js/worker.js');
    state.worker.onmessage = onWorkerMsg;
    state.worker.onerror = (e) => {
      setStatus('stWasm', false, 'Worker 错误');
      toast('推理线程启动失败: ' + (e.message || '未知错误'), true);
    };
  }
  setStatus('stEngine', true, hasWebGPU ? '引擎就绪 · WebGPU' : '引擎就绪 · CPU(WASM)');
  state.engineReady = true;
}

function onWorkerMsg(e) {
  const m = e.data;
  switch (m.type) {
    case 'ready':
      setStatus('stWasm', true, 'WASM 就绪');
      break;
    case 'model_progress':
      setStage('stgLoad', m.progress, m.text || '下载模型 ' + Math.round(m.progress) + '%');
      break;
    case 'model_loaded':
      state.modelReady = true;
      setStatus('stModel', true, '模型已加载 · ' + MODELS[state.model].name);
      setStage('stgLoad', 100, '模型加载完成');
      if (state.pendingStart) { const p = state.pendingStart; state.pendingStart = null; doInfer(p); }
      break;
    case 'infer_progress':
      setStage('stgInfer', m.progress, m.text || '处理中 ' + Math.round(m.progress) + '%');
      break;
    case 'result':
      state.alpha = m.alpha;
      state.elapsed = m.elapsed;
      renderResult();
      setStage('stgInfer', 100, '完成 · ' + m.elapsed.toFixed(1) + 's');
      state.busy = false;
      setButtons(true);
      break;
    case 'error':
      state.busy = false;
      setButtons(true);
      toast('处理失败: ' + (m.message || '未知错误'), true);
      setStage('stgInfer', 0, '处理失败');
      break;
  }
}

function setStage(id, pct, txt) {
  const st = $(id); if (!st) return;
  const bar = st.querySelector('.bar');
  const txtEl = st.querySelector('.txt');
  if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  if (txtEl) txtEl.innerHTML = txt;
  st.classList.add('active');
  if (pct >= 100) st.classList.add('done');
}

function setButtons(enable) {
  $('btnDownload').disabled = !enable || !state.alpha;
  $('btnCompare').disabled = !enable || !state.alpha;
  $('btnReset').disabled = !enable;
  $('btnFile').disabled = !enable;
}

/* ---------- 上传 ---------- */
function setupUpload() {
  const zone = $('uploadZone');
  const input = $('fileInput');
  $('btnFile').addEventListener('click', (e) => { e.stopPropagation(); input.click(); });
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => {
    if (input.files && input.files[0]) handleFile(input.files[0]);
    input.value = '';
  });
  ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => {
    e.preventDefault(); zone.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => {
    e.preventDefault(); zone.classList.remove('dragover');
  }));
  zone.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) { handleFile(f); return; }
      }
    }
  });
  $('bgSwatches').addEventListener('click', (e) => {
    const b = e.target.closest('.sw'); if (!b) return;
    state.bg = b.dataset.bg;
    $('bgSwatches').querySelectorAll('.sw').forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
    renderResult();
  });
  $('modelSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-model]'); if (!b || state.busy) return;
    state.model = b.dataset.model;
    $('modelSeg').querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', x === b ? 'true' : 'false'));
    const info = MODELS[state.model];
    $('modelDesc').textContent = info.name + ' · ' + info.size;
    if (state.modelReady && state.worker) {
      state.modelReady = false;
      setStatus('stModel', null, '切换模型 · ' + info.name);
      setStage('stgLoad', 0, '加载新模型…');
      state.worker.postMessage({ type: 'load_model', model: state.model });
    }
  });
  $('sizeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-size]'); if (!b) return;
    state.outSize = b.dataset.size;
    $('sizeSeg').querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', x === b ? 'true' : 'false'));
    if (state.alpha && state.image) renderResult();
  });
  $('btnDownload').addEventListener('click', downloadPng);
  $('btnReset').addEventListener('click', resetAll);
  $('btnReplace').addEventListener('click', () => $('fileInput').click());
  $('btnCompare').addEventListener('click', toggleCompare);
  setupCompareSlider();
}

async function handleFile(file) {
  if (state.busy) { toast('请等待当前处理完成'); return; }
  if (!file.type || !/^image\/(jpeg|png|webp)$/i.test(file.type)) {
    toast('仅支持 JPG / PNG / WebP 格式', true); return;
  }
  if (file.size > MAX_FILE) {
    toast('图片超过 25MB（当前 ' + (file.size / 1048576).toFixed(1) + 'MB）', true); return;
  }
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    if (bmp.width > MAX_DIM || bmp.height > MAX_DIM) {
      toast('图片尺寸 ' + bmp.width + '×' + bmp.height + ' 过大，将自动缩放到 4096 内处理');
    }
    state.image = bmp;
    state.backup = null;
    state.width = bmp.width; state.height = bmp.height;
    state.alpha = null;
    showOriginal();
    $('metaOrig').textContent = bmp.width + '×' + bmp.height + ' · ' + file.type.replace('image/', '').toUpperCase();
    $('metaResult').textContent = '';
    $('phResult').style.display = 'flex';
    $('canvasResult').hidden = true;
    $('compareSlider').classList.remove('show');
    setButtons(false);
    await initEngine();
    if (!state.modelReady) {
      setStage('stgLoad', 0, '下载模型 ' + MODELS[state.model].name + '…');
      state.pendingStart = { file };
      state.worker.postMessage({ type: 'load_model', model: state.model });
    } else {
      doInfer({ file });
    }
  } catch (e) {
    toast('无法解析图片（文件可能已损坏）', true);
  }
}

async function doInfer(p) {
  if (state.busy) return;
  state.busy = true;
  setButtons(false);
  setStage('stgInfer', 0, '预处理…');
  const bmp = state.image;
  // 注意: transfer 会 detach bitmap, 先备份一份用于结果合成
  const backup = document.createElement('canvas');
  backup.width = state.width; backup.height = state.height;
  backup.getContext('2d').drawImage(bmp, 0, 0);
  state.backup = backup;
  state.worker.postMessage(
    { type: 'infer', bitmap: bmp, model: state.model, outSize: state.outSize, norm: MODELS[state.model].norm },
    [bmp]
  );
}

/* ---------- 渲染 ---------- */
function showOriginal() {
  const cv = $('canvasOrig');
  cv.width = state.width; cv.height = state.height;
  const ctx = cv.getContext('2d');
  ctx.drawImage(state.backup || state.image, 0, 0);
  cv.hidden = false;
  $('phOrig').style.display = 'none';
  $('hintOrig').textContent = state.width + '×' + state.height;
}

function renderResult() {
  if (!state.alpha) return;
  const wrap = $('resultWrap');
  wrap.className = 'canvas-wrap' + (state.bg === 'white' ? ' no-checker' : '');
  wrap.style.background = state.bg === 'white' ? '#fff'
    : state.bg === 'black' ? '#171717'
    : state.bg === 'gray' ? '#9a978c'
    : '';
  const cv = $('canvasResult');
  const target = getOutSize();
  cv.width = target.w; cv.height = target.h;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  // 逐像素 alpha 合成
  const imgCv = document.createElement('canvas');
  imgCv.width = state.width; imgCv.height = state.height;
  const ictx = imgCv.getContext('2d');
  ictx.drawImage(state.backup || state.image, 0, 0);
  const imgData = ictx.getImageData(0, 0, state.width, state.height);
  const px = imgData.data;
  for (let i = 0; i < state.alpha.length; i++) {
    px[i * 4 + 3] = Math.round(state.alpha[i] * 255);
  }
  const ocv = document.createElement('canvas');
  ocv.width = state.width; ocv.height = state.height;
  ocv.getContext('2d').putImageData(imgData, 0, 0);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(ocv, 0, 0, target.w, target.h);
  cv.hidden = false;
  $('phResult').style.display = 'none';
  $('metaResult').textContent = target.w + '×' + target.h + (state.elapsed ? ' · ' + state.elapsed.toFixed(1) + 's' : '');
  $('btnDownload').disabled = false;
}

function getOutSize() {
  const s = state.outSize;
  if (s === 'orig') return { w: state.width, h: state.height };
  const max = parseInt(s, 10);
  const scale = Math.min(1, max / Math.max(state.width, state.height));
  return { w: Math.max(1, Math.round(state.width * scale)), h: Math.max(1, Math.round(state.height * scale)) };
}

/* ---------- 下载 ---------- */
async function downloadPng() {
  if (!state.alpha) return;
  const cv = $('canvasResult');
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  if (!blob) { toast('导出失败', true); return; }
  const a = document.createElement('a');
  a.download = 'cutout.png';
  a.href = URL.createObjectURL(blob);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('已下载透明 PNG');
}

/* ---------- 原图对比滑块 ---------- */
function setupCompareSlider() {
  const slider = $('compareSlider');
  const divider = $('csDivider');
  let dragging = false;
  function setPos(x) {
    const rect = slider.getBoundingClientRect();
    let pct = ((x - rect.left) / rect.width) * 100;
    pct = Math.max(4, Math.min(96, pct));
    divider.style.left = pct + '%';
    $('csResult').style.clipPath = 'inset(0 ' + (100 - pct) + '% 0 0)';
  }
  divider.addEventListener('pointerdown', (e) => { dragging = true; divider.setPointerCapture(e.pointerId); });
  divider.addEventListener('pointermove', (e) => { if (dragging) setPos(e.clientX); });
  divider.addEventListener('pointerup', () => { dragging = false; });
  slider.addEventListener('click', (e) => { if (!dragging) setPos(e.clientX); });
}

function toggleCompare() {
  const slider = $('compareSlider');
  const btn = $('btnCompare');
  const show = !slider.classList.contains('show');
  if (show) {
    $('csOrig').innerHTML = '';
    $('csResult').innerHTML = '';
    const img = new Image();
    img.src = $('canvasOrig').toDataURL();
    const img2 = new Image();
    img2.src = $('canvasResult').toDataURL();
    const clone = (src, container) => {
      const c = document.createElement('canvas');
      const t = getOutSize();
      c.width = t.w; c.height = t.h;
      c.getContext('2d').drawImage(src, 0, 0);
      container.appendChild(c);
    };
    img.onload = () => { clone(img, $('csOrig')); };
    img2.onload = () => { clone(img2, $('csResult')); $('csResult').style.clipPath = 'inset(0 50% 0 0)'; };
  }
  slider.classList.toggle('show', show);
  btn.setAttribute('aria-pressed', show ? 'true' : 'false');
  btn.textContent = show ? '退出对比' : '原图对比';
}

/* ---------- 重置 ---------- */
function resetAll() {
  state.image = null; state.alpha = null; state.elapsed = 0;
  state.pendingStart = null;
  $('canvasOrig').hidden = true;
  $('canvasResult').hidden = true;
  $('phOrig').style.display = 'flex';
  $('phResult').style.display = 'flex';
  $('metaOrig').textContent = ''; $('metaResult').textContent = '';
  $('hintOrig').textContent = '';
  $('compareSlider').classList.remove('show');
  $('btnCompare').textContent = '原图对比';
  $('btnCompare').setAttribute('aria-pressed', 'false');
  setButtons(false);
  setStage('stgLoad', 0, '等待…');
  setStage('stgInfer', 0, '等待…');
}

/* ---------- init ---------- */
document.addEventListener('DOMContentLoaded', () => {
  setupUpload();
  setStatus('stEngine', null, '推理引擎待加载');
  setStatus('stModel', null, '模型未加载');
  setStatus('stWasm', null, 'WASM 待就绪');
  setTimeout(() => { if (!state.engineReady) initEngine().catch(() => {}); }, 800);
});
