import { Renderer, Metrics } from './renderer.js';
import { hasIdleCallback } from './idle-scheduler.js';

const $ = (id) => document.getElementById(id);

const els = {
  canvas: $('canvas'), overlay: $('overlay'),
  resolution: $('resolution'), tileSize: $('tileSize'), maxIter: $('maxIter'),
  workerCount: $('workerCount'), forceMain: $('forceMain'), injectError: $('injectError'),
  jamWorker: $('jamWorker'),
  startBtn: $('startBtn'), cancelBtn: $('cancelBtn'), retryBtn: $('retryBtn'),
  resetViewBtn: $('resetViewBtn'), clearLog: $('clearLog'),
  mStatus: $('mStatus'), mProgress: $('mProgress'), mTiles: $('mTiles'),
  mPixels: $('mPixels'), mElapsed: $('mElapsed'), mRate: $('mRate'),
  mMode: $('mMode'), mFps: $('mFps'), mFailed: $('mFailed'), mLongTasks: $('mLongTasks'),
  log: $('log'),
};

const ui = {
  ricAvailable: hasIdleCallback,
  log(level, msg) {
    const li = document.createElement('li');
    if (level) li.className = level;
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const ts = document.createElement('span');
    ts.className = 't';
    ts.textContent = t;
    li.append(ts, `${msg}`);
    els.log.appendChild(li);
    while (els.log.children.length > 200) els.log.removeChild(els.log.firstChild);
    els.log.scrollTop = els.log.scrollHeight;
  },
  setStatus(s) { els.mStatus.textContent = s; },
  setMode(s) { els.mMode.textContent = s; },
  setFps(n) { els.mFps.textContent = n; },
  setLongTasks(n) { els.mLongTasks.textContent = n; },
  setProgress(ratio, done, total) {
    els.mProgress.textContent = `${(ratio * 100).toFixed(1)}%`;
    els.mPixels.textContent = `${done.toLocaleString()} / ${total.toLocaleString()}`;
  },
  setTiles(done, total, failed) {
    els.mTiles.textContent = `${done} / ${total}`;
    els.mFailed.textContent = failed;
  },
  setPerf(elapsed, done) {
    els.mElapsed.textContent = `${elapsed.toFixed(1)} s`;
    els.mRate.textContent = `${elapsed > 0.05 ? Math.round(done / elapsed).toLocaleString() : '0'} px/s`;
  },
  setControlsRunning(running) {
    els.startBtn.disabled = running;
    els.cancelBtn.disabled = !running;
    if (!running) els.retryBtn.disabled = Number(els.mFailed.textContent) === 0;
  },
  setOverlay(text) {
    els.overlay.textContent = text;
    els.overlay.classList.toggle('hidden', !text);
  },
  get retryBtn() { return els.retryBtn; },
};

function readOptions() {
  const [width, height] = els.resolution.value.split('x').map(Number);
  return {
    width, height,
    tileSize: Number(els.tileSize.value),
    maxIter: Number(els.maxIter.value),
    workerCount: Number(els.workerCount.value),
    forceMain: els.forceMain.checked,
    failRate: els.injectError.checked ? 0.08 : 0,
    jamWorker: els.jamWorker.checked,
  };
}

const renderer = new Renderer(els.canvas, ui);
renderer.configure(readOptions());
const metrics = new Metrics(ui);
metrics.start();

els.startBtn.addEventListener('click', () => {
  renderer.configure(readOptions());
  renderer._jammed = false;
  ui.log('ok', `开始：${renderer.opts.width}×${renderer.opts.height}，`
    + `分片 ${renderer.opts.tileSize}px，迭代 ${renderer.opts.maxIter}`);
  renderer.start(false);
});

els.cancelBtn.addEventListener('click', () => renderer.cancel());
els.retryBtn.addEventListener('click', () => {
  if (renderer.running) return;
  renderer.configure(readOptions());
  renderer._jammed = false;
  renderer.start(true);
});
els.resetViewBtn.addEventListener('click', () => {
  renderer.view = { cx: -0.5, cy: 0, zoom: 1 };
  ui.log('视图已重置');
});
els.clearLog.addEventListener('click', () => { els.log.innerHTML = ''; });

// 画布交互：点击放大、Shift+点击缩小（坐标由画布像素映射回复数平面）
els.canvas.addEventListener('click', (e) => {
  const rect = els.canvas.getBoundingClientRect();
  const px = (e.clientX - rect.left) / rect.width * els.canvas.width;
  const py = (e.clientY - rect.top) / rect.height * els.canvas.height;
  const width = els.canvas.width;
  const height = els.canvas.height;
  const { view } = renderer;
  if (!renderer.opts) return;
  const aspect = width / height;
  const scale = 3.2 / view.zoom;
  const cx = (px / width - 0.5) * scale * aspect + view.cx;
  const cy = (py / height - 0.5) * scale + view.cy;
  const factor = e.shiftKey ? 0.5 : 2;
  renderer.view = { cx, cy, zoom: Math.max(1, view.zoom * factor) };
  ui.log(`视图${e.shiftKey ? '缩小' : '放大'}至 zoom=${renderer.view.zoom.toFixed(1)}，点击“开始计算”重绘`);
});

if (!hasIdleCallback) {
  ui.log('warn', '当前环境不支持 requestIdleCallback，已启用 setTimeout 降级调度');
}
els.mMode.textContent = '—';
