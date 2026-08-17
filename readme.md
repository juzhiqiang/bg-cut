# 净图 JING CUT

**纯前端 AI 抠图** — 模型在浏览器本地运行，图片不出设备。

- 模型：BRIA RMBG-1.4（FP16，88MB，均衡档）/ BRIA RMBG-2.0（Q4F16，234MB，高精档），BiRefNet 架构
- 引擎：ONNX Runtime Web 1.27（WebGPU 加速 + WASM CPU 回退）
- 模型托管：ModelScope（主源 + AI-ModelScope 镜像备源）
- 参照：对标 VoltTool 的 `@imgly/background-removal`（ISNet 模型），本站在质量与国内可达性上均更优

## 在线访问

<https://juzhiqiang.github.io/bg-cut/>

## 本地运行

```bash
# 任意静态服务器均可，例如：
python -m http.server 8080
# 或
node server.js 8080
# 然后访问 http://localhost:8080
```

> 注意：请勿用 file:// 直接打开（Worker 与 WASM 需要 HTTP 环境）。

## 目录结构

| 路径 | 说明 |
|---|---|
| `index.html` | 页面与全部样式（Build 奢侈极简风） |
| `js/main.js` | 主线程逻辑：上传/预览/下载/对比滑块/状态机 |
| `js/worker.js` | 推理 Worker：模型下载、预处理（正方形缩放 + mean0.5/std1.0 归一化）、ONNX 推理、双线性上采样 |
| `js/ort.*` | ONNX Runtime Web 运行时（自托管，无外部 CDN 依赖） |
| `server.js` | 可选本地静态服务器 |

## 修改指南

| 想改什么 | 改哪里 |
|---|---|
| 模型源 URL / 新增模型 | `js/main.js` 与 `js/worker.js` 中的 `MODELS` / `urls` 数组 |
| 归一化参数 | `js/main.js` `MEAN/STD` 与 `js/worker.js` `MEAN/STD`（RMBG 系列为 0.5/1.0） |
| 上传大小限制 | `js/main.js` `MAX_FILE` / `MAX_DIM` |
| 品牌色 / 字体 / 布局 | `index.html` 中 `:root` CSS 变量与各区块 |
| 文案 | `index.html` 中对应区块 |

## 技术要点

- **推理流程**：上传 → `createImageBitmap` 本地解码 → Worker 内正方形缩放（ISNet/RMBG-1.4 固定 1024²，RMBG-2.0 原生 2048²）→ `(x/255 - 0.5)/1.0` 归一化 → ONNX 推理 → alpha 双线性上采样回原尺寸 → 主线程合成透明 PNG
- **归一化**：RMBG 系列官方为 mean 0.5 / std 1.0（非 ImageNet 参数——用错会导致背景残留，本项目已踩坑并修正）
- **性能**：WebGPU 优先，无 GPU 自动回退 WASM；高精档在 CPU 上自动降至 1024 推理防卡顿
- **隐私**：零上传。推理期间除模型 CDN 外无任何网络请求

## 模型许可

- BRIA RMBG-1.4：bria-rmbg-1.4 license（免费非商业使用）
- BRIA RMBG-2.0：bria-rmbg-2.0 license（免费非商业使用）
- ONNX Runtime：MIT

## 许可证

本项目代码 MIT License。
