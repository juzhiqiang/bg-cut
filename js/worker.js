/* 净图 JING CUT — 推理 Worker: 模型加载 + 前/后处理 + ONNX Runtime */
'use strict';

const MODELS = {
  rmbg_1_4: {
    inputName: 'input',
    outputName: 'output',
    inferSize: 1024,
    urls: [
      'https://modelscope.cn/models/briaai/RMBG-1.4/resolve/master/onnx/model_fp16.onnx',
      'https://modelscope.cn/models/AI-ModelScope/RMBG-1.4/resolve/master/onnx/model_fp16.onnx',
    ],
  },
  rmbg_2_0: {
    inputName: 'pixel_values',
    outputName: 'alphas',
    inferSize: 2048,
    urls: [
      'https://modelscope.cn/models/briaai/RMBG-2.0/resolve/master/onnx/model_q4f16.onnx',
      'https://modelscope.cn/models/AI-ModelScope/RMBG-2.0/resolve/master/onnx/model_q4f16.onnx',
    ],
  },
};
const MEAN = [0.5, 0.5, 0.5];
const STD = [1.0, 1.0, 1.0];

let ortLib = null;
let session = null;
let currentModel = null;
let busy = false;
let currentEp = 'wasm';

/* ---------- 动态加载 onnxruntime (主线程已加载全局 ort; worker 内也可再保险) ---------- */
async function ensureOrt() {
  if (ortLib) return;
  // worker 内尝试从主线程全局对象获取
  if (typeof self.ort !== 'undefined') { ortLib = self.ort; return; }
  // 否则动态 import 同源 js
  await importScriptsFallback();
}

function importScriptsFallback() {
  return new Promise((resolve, reject) => {
    try {
      importScripts('ort.all.min.js');
      ortLib = self.ort;
      // 显式指定 wasm 文件路径 (与 worker 同目录)
      ortLib.env.wasm.wasmPaths = new URL('.', self.location.href).href;
      resolve();
    } catch (e) { reject(e); }
  });
}

/* ---------- 带进度 fetch ---------- */
async function fetchWithProgress(url, onProgress) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('模型下载失败 HTTP ' + resp.status);
  const total = Number(resp.headers.get('content-length')) || 0;
  if (!resp.body) {
    const buf = await resp.arrayBuffer();
    onProgress && onProgress(1);
    return buf;
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total && onProgress) onProgress(received / total);
  }
  const all = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.length; }
  onProgress && onProgress(1);
  return all.buffer;
}

/* ---------- 模型加载 ---------- */
async function loadModel(modelKey) {
  if (currentModel === modelKey && session) {
    postMessage({ type: 'model_loaded' });
    return;
  }
  await ensureOrt();
  const cfg = MODELS[modelKey];
  let buf = null;
  let lastErr = null;
  for (const url of cfg.urls) {
    try {
      buf = await fetchWithProgress(url, (p) => {
        postMessage({ type: 'model_progress', progress: p * 90, text: `下载模型 ${(p * 100).toFixed(0)}%` });
      });
      break;
    } catch (e) { lastErr = e; }
  }
  if (!buf) throw new Error(lastErr ? lastErr.message : '模型下载失败（网络不可达）');
  postMessage({ type: 'model_progress', progress: 92, text: '解析模型…' });

  // 尝试 WebGPU, 回退 CPU (wasm)
  let ep = 'wasm';
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) ep = 'webgpu';
    }
  } catch (e) { /* ignore */ }

  const so = { executionProviders: [], logSeverityLevel: 3 };
  let epName = 'wasm';
  if (ep === 'webgpu') {
    so.executionProviders.push({ name: 'webgpu', deviceId: 0 });
    epName = 'webgpu';
  } else {
    so.executionProviders.push({ name: 'wasm' });
  }

  postMessage({ type: 'model_progress', progress: 95, text: '初始化推理会话（' + epName + '）…' });
  const t0 = performance.now();
  session = await ortLib.InferenceSession.create(buf, so);
  currentEp = epName;
  console.log('[worker] session created in', ((performance.now() - t0) / 1000).toFixed(1) + 's', 'ep:', epName);
  currentModel = modelKey;
  postMessage({ type: 'model_loaded', ep: epName });
}

/* ---------- 前处理: 正方形缩放 + 归一化 (模型均为正方形输入) ---------- */
function preprocess(bitmap, size) {
  const w = size, h = size;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  // NCHW float32
  const n = w * h;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4] / 255, g = data[i * 4 + 1] / 255, b = data[i * 4 + 2] / 255;
    out[i] = (r - MEAN[0]) / STD[0];
    out[n + i] = (g - MEAN[1]) / STD[1];
    out[2 * n + i] = (b - MEAN[2]) / STD[2];
  }
  return { tensor: new ortLib.Tensor('float32', out, [1, 3, h, w]), w, h };
}

/* ---------- 后处理 ---------- */
function postprocess(output, srcW, srcH, outSize) {
  // output: [1,1,H,W] 概率图
  const data = output.data;
  const oh = output.dims[2], ow = output.dims[3];
  // 上采样到输出尺寸 (双线性, 主线程做最终合成; 这里先返回原图尺寸 alpha)
  const scale = outSize === 'orig' ? 1 : Math.min(1, parseInt(outSize, 10) / Math.max(srcW, srcH));
  const tw = Math.max(1, Math.round(srcW * scale));
  const th = Math.max(1, Math.round(srcH * scale));
  const alpha = bilinearResize(data, ow, oh, tw, th);
  return { alpha, w: tw, h: th };
}

function bilinearResize(src, sw, sh, tw, th) {
  const out = new Float32Array(tw * th);
  const xs = sw / tw, ys = sh / th;
  for (let y = 0; y < th; y++) {
    const sy = y * ys;
    const y0 = Math.floor(sy), y1 = Math.min(sh - 1, y0 + 1);
    const fy = sy - y0;
    const row0 = y0 * sw, row1 = y1 * sw;
    for (let x = 0; x < tw; x++) {
      const sx = x * xs;
      const x0 = Math.floor(sx), x1 = Math.min(sw - 1, x0 + 1);
      const fx = sx - x0;
      const v = src[row0 + x0] * (1 - fx) * (1 - fy) + src[row0 + x1] * fx * (1 - fy) +
                src[row1 + x0] * (1 - fx) * fy + src[row1 + x1] * fx * fy;
      out[y * tw + x] = Math.max(0, Math.min(1, v));
    }
  }
  return out;
}

/* ---------- 推理 ---------- */
async function infer(bitmap, modelKey, outSize) {
  const cfg = MODELS[modelKey];
  // 高精档在 CPU 上限制推理尺寸为 1024 (WebGPU 可用 2048), 避免长时间卡顿
  let inferSize = cfg.inferSize;
  if (inferSize > 1024 && currentEp !== 'webgpu') inferSize = 1024;
  postMessage({ type: 'infer_progress', progress: 5, text: '预处理…' });
  const { tensor, w, h } = preprocess(bitmap, inferSize);
  postMessage({ type: 'infer_progress', progress: 10, text: `推理中 (${w}×${h})…` });
  const t0 = performance.now();
  const feeds = {};
  feeds[cfg.inputName] = tensor;
  const results = await session.run(feeds);
  const out = results[cfg.outputName] || Object.values(results)[0];
  const elapsed = (performance.now() - t0) / 1000;
  postMessage({ type: 'infer_progress', progress: 85, text: '后处理…' });
  const { alpha, w: aw, h: ah } = postprocess(out, bitmap.width, bitmap.height, outSize);
  postMessage({ type: 'infer_progress', progress: 100, text: '完成' });
  return { alpha, aw, ah, elapsed };
}

/* ---------- 消息处理 ---------- */
self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'load_model') {
      await loadModel(m.model);
    } else if (m.type === 'infer') {
      if (busy) return;
      busy = true;
      const r = await infer(m.bitmap, m.model, m.outSize);
      postMessage({ type: 'result', alpha: r.alpha, width: r.aw, height: r.ah, elapsed: r.elapsed }, [r.alpha.buffer]);
      busy = false;
    }
  } catch (err) {
    busy = false;
    postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};

postMessage({ type: 'ready' });
