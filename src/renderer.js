// 主编排器：分片切分、空闲分发、Worker 池 / 主线程降级、
// 协作式中断、像素加权进度、重试与 Canvas 渐进绘制、性能指标。

import { scheduleIdle, cancelIdle } from './idle-scheduler.js';
import { WorkerPool } from './worker-pool.js';
import { tilePixels } from './mandelbrot.js';

const MAX_RETRY = 2;

export class Renderer {
  constructor(canvas, ui) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ui = ui;

    this.view = { cx: -0.5, cy: 0, zoom: 1 };
    this.running = false;
    this.cancelled = false;
    this.generation = 0; // 每次 start 自增，作废上一代迟到结果
    this.pool = null;
    this.mode = 'idle'; // idle | worker | main
    this.degrading = false;

    this.queue = [];
    this.tiles = new Map();
    this.inflight = 0;
    this.totalPixels = 0;
    this.donePixels = 0;
    this.failedCount = 0;
    this.startTime = 0;
  }

  configure(opts) { this.opts = opts; }

  // ---------- 生命周期 ----------

  async start(onlyRetry = false) {
    if (this.running) return;
    this.generation++;
    this.cancelled = false;
    this.running = true;
    this.degrading = false;
    this.inflight = 0;
    this.donePixels = onlyRetry ? this.donePixels : 0;
    this.failedCount = onlyRetry ? this.failedCount : 0;
    this.startTime = performance.now();

    const { width, height, tileSize, maxIter, workerCount, forceMain, failRate } = this.opts;
    if (!onlyRetry) {
      this.canvas.width = width;
      this.canvas.height = height;
      this._clearCanvas();
      this._buildTiles(width, height, tileSize);
    } else {
      // 重试：只把 failed 片重新入队
      for (const [key, t] of this.tiles) {
        if (t.state !== 'failed') continue;
        t.state = 'pending';
        t.attempts = 0;
        this.queue.push(t);
      }
    }

    this.totalPixels = width * height;
    this.ui.setOverlay('');
    this.ui.setStatus(onlyRetry ? '重试失败片…' : '计算中…');
    this.ui.setControlsRunning(true);
    this.ui.retryBtn.disabled = true;

    if (!forceMain && await this._tryInitPool(workerCount)) {
      this.mode = 'worker';
    } else {
      this.mode = 'main';
      if (!forceMain) this.ui.log('warn', 'Worker 不可用，降级为主线程分片模式');
      else this.ui.log('warn', '已强制主线程分片模式（空闲切片 + 扫描行检查点）');
    }
    this.ui.setMode(this.mode === 'worker'
      ? `Worker × ${this.pool.alive}`
      : `主线程${this.ui.ricAvailable ? '' : '（无 RIC）'}`);

    this._pump();
  }

  async _tryInitPool(requested) {
    const auto = Math.max(1, (navigator.hardwareConcurrency || 4) - 1);
    const size = requested > 0 ? Math.min(requested, 16) : auto;
    this.ui.setOverlay('正在启动 Worker…');
    this.ui.log(`初始化 ${size} 个 Worker…`);
    try {
      this.pool = new WorkerPool(size, { onLog: (lvl, msg) => this.ui.log(lvl, msg) });
      await this.pool.init();
      this.ui.log('ok', `Worker 就绪（${this.pool.alive} 个）`);
      this.ui.setOverlay('');
      return true;
    } catch (err) {
      this.ui.log('warn', `Worker 启动失败：${err.message}，降级主线程`);
      this._disposePool();
      return false;
    }
  }

  cancel(reason = '用户中断') {
    if (!this.running) return;
    this.cancelled = true;
    this.generation++;
    this.ui.log('warn', `已中断（${reason}）：停止分发，在途分片结果作废`);
    if (this.pumpHandle) { cancelIdle(this.pumpHandle); this.pumpHandle = null; }
    // Worker 直接终止；在途任务结果统一由 generation 作废
    this._disposePool();
    this._finish(reason, true);
  }

  _disposePool() {
    if (this.pool) {
      try { this.pool.terminate(); } catch (_) {}
      this.pool = null;
    }
  }

  // ---------- 分片 ----------

  _buildTiles(width, height, tileSize) {
    this.tiles.clear();
    this.queue = [];
    for (let y = 0; y < height; y += tileSize) {
      for (let x = 0; x < width; x += tileSize) {
        const w = Math.min(tileSize, width - x);
        const h = Math.min(tileSize, height - y);
        const tile = { x, y, w, h, pixels: w * h, state: 'pending', attempts: 0, key: `${x},${y}` };
        this.tiles.set(tile.key, tile);
        this.queue.push(tile);
      }
    }
    // 交错入队带来更均匀的渐进画面
    this.queue = this._interleave(this.queue);
  }

  _interleave(list) {
    const out = [];
    const stride = Math.ceil(Math.sqrt(list.length));
    for (let i = 0; i < stride; i++) {
      for (let j = i; j < list.length; j += stride) out.push(list[j]);
    }
    return out.length === list.length ? out : list;
  }

  // ---------- 调度 ----------

  _pump = () => {
    this.pumpHandle = null;
    if (!this.running || this.cancelled) return;
    const concurrency = this.mode === 'worker'
      ? (this.pool ? this.pool.alive * 2 : 1)
      : 1; // 主线程只跑一个分片，保证检查点让出期间 UI 可响应
    while (!this.cancelled && this.queue.length && this.inflight < concurrency) {
      const tile = this.queue.shift();
      if (tile.state !== 'pending') continue;
      tile.state = 'running';
      tile.attempts++;
      this.inflight++;
      this._processTile(tile, this.generation);
    }
    this._updateProgress();
    if (!this.inflight && !this.queue.length) {
      this._finish(this.failedCount ? `完成（${this.failedCount} 片失败）` : '完成', false);
    }
  };

  _schedulePump() {
    if (this.cancelled || this.pumpHandle) return;
    this.pumpHandle = scheduleIdle(() => this._pump(), 50);
  }

  async _processTile(tile, gen) {
    const { width, height, maxIter, failRate, jamWorker } = this.opts;
    const payload = {
      tile: { x: tile.x, y: tile.y, w: tile.w, h: tile.h },
      width, height, view: this.view, maxIter,
      failRate: failRate || 0,
    };
    try {
      let buffer;
      if (this.mode === 'worker' && this.pool && !this.degrading) {
        const res = await this.pool.run(payload);
        buffer = res.buffer;
        if (jamWorker && this.pool && !this._jammed) {
          this._jammed = true;
          this.ui.log('warn', '模拟 Worker 崩溃：终止全部 Worker');
          this._disposePool();
          this.mode = 'main';
          this.degrading = true;
          this.ui.setMode('主线程（模拟崩溃降级）');
        }
      } else {
        buffer = await this._runOnMain(payload, gen, tile);
      }
      if (gen !== this.generation || this.cancelled) return; // 迟到结果丢弃
      this._paint(tile, buffer);
      tile.state = 'done';
      if (!tile._counted) { this.donePixels += tile.pixels; tile._counted = true; }
    } catch (err) {
      if (gen !== this.generation || this.cancelled) return;
      await this._handleError(tile, err, gen);
      return;
    } finally {
      if (gen === this.generation && !this.cancelled) {
        this.inflight = Math.max(0, this.inflight - 1);
        this._schedulePump();
      }
    }
    this._updateProgress();
  }

  // 主线程执行：在空闲切片中逐扫描行推进，异步检查点让出事件循环
  _runOnMain(payload, gen, tile) {
    return new Promise((resolve, reject) => {
      let sliceStart = performance.now();
      const checkpoint = () => {
        if (this.cancelled || gen !== this.generation) return false;
        const elapsed = performance.now() - sliceStart;
        if (elapsed < 4) return true; // 单片内小切片预算 ~4ms
        // 让出事件循环，等待下一空闲时段再继续
        return new Promise((keepGoing) => {
          scheduleIdle(() => {
            if (this.cancelled || gen !== this.generation) { keepGoing(false); return; }
            sliceStart = performance.now();
            keepGoing(true);
          }, 30);
        });
      };
      try {
        const ret = tilePixels(payload, checkpoint);
        if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
        else resolve(ret);
      } catch (err) {
        reject(err);
      }
    });
  }

  async _handleError(tile, err, gen) {
    if (err && err.aborted) return;
    if (err && err.crash && this.mode === 'worker' && this.pool) {
      this.ui.log('error', `Worker 崩溃导致分片失败：${err.message}`);
      if (!this.degrading) {
        this.degrading = true;
        this.mode = 'main';
        this.ui.setMode('主线程（Worker 崩溃降级）');
        this.ui.log('warn', '已降级为主线程模式，其余分片继续执行');
      }
    } else if (err && err.code === 'INJECTED') {
      this.ui.log('warn', `分片 (${tile.x},${tile.y}) 第 ${tile.attempts} 次失败`);
    } else {
      this.ui.log('error', `分片 (${tile.x},${tile.y}) 异常：${err.message}`);
    }
    if (tile.attempts <= MAX_RETRY) {
      tile.state = 'pending';
      this.queue.push(tile); // 队尾重试
    } else {
      // 重试场景下该片可能在上一轮已计入完成像素，扣回，保证进度不超 100%
      if (tile._counted) { this.donePixels -= tile.pixels; tile._counted = false; }
      tile.state = 'failed';
      this.failedCount++;
      this._paintFailed(tile);
      this.ui.retryBtn.disabled = false;
    }
  }

  // ---------- 绘制 ----------

  _paint(tile, buffer) {
    try {
      const data = new Uint8ClampedArray(buffer);
      const imageData = new ImageData(data, tile.w, tile.h);
      this.ctx.putImageData(imageData, tile.x, tile.y);
    } catch (err) {
      // Canvas 不可用（如上下文丢失）属严重异常：标记失败并提示
      this.ui.log('error', `Canvas 绘制失败：${err.message}`);
      throw err;
    }
  }

  _paintFailed(tile) {
    try {
      this.ctx.fillStyle = 'rgba(255,60,80,0.85)';
      this.ctx.fillRect(tile.x, tile.y, tile.w, tile.h);
    } catch (_) {}
  }

  _clearCanvas() {
    try {
      this.ctx.fillStyle = '#0a0d1a';
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    } catch (err) {
      this.ui.log('error', 'Canvas 初始化失败：' + err.message);
    }
  }

  // ---------- 收尾 / 指标 ----------

  _finish(status, interrupted) {
    if (!this.running) return;
    this.running = false;
    if (this.pumpHandle) { cancelIdle(this.pumpHandle); this.pumpHandle = null; }
    this._disposePool();
    const elapsed = (performance.now() - this.startTime) / 1000;
    this.ui.setStatus(status);
    this.ui.setControlsRunning(false);
    this.ui.retryBtn.disabled = this.failedCount === 0;
    this.ui.setOverlay(interrupted ? '已中断' : (this.failedCount ? '部分完成' : '完成'));
    this.ui.log(interrupted ? 'warn' : 'ok',
      `${status}，耗时 ${elapsed.toFixed(2)}s，已完成像素 ${this.donePixels}/${this.totalPixels}`);
  }

  _updateProgress() {
    const ratio = this.totalPixels ? this.donePixels / this.totalPixels : 0;
    this.ui.setProgress(ratio, this.donePixels, this.totalPixels);
    let doneTiles = 0;
    for (const [, t] of this.tiles) if (t.state === 'done' || t.state === 'failed') doneTiles++;
    this.ui.setTiles(doneTiles, this.tiles.size, this.failedCount);
    const elapsed = this.running ? (performance.now() - this.startTime) / 1000 : 0;
    this.ui.setPerf(elapsed, this.donePixels);
  }
}

// 指标计时器：FPS、长任务（PerformanceObserver）、吞吐刷新
export class Metrics {
  constructor(ui) {
    this.ui = ui;
    this.frames = 0;
    this.fps = 60;
    this.longTasks = 0;
    this.last = performance.now();
    this._raf = null;
  }

  start() {
    const loop = () => {
      this.frames++;
      const now = performance.now();
      if (now - this.last >= 500) {
        this.fps = Math.round(this.frames * 1000 / (now - this.last));
        this.ui.setFps(this.fps);
        this.frames = 0;
        this.last = now;
      }
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);

    if ('PerformanceObserver' in window) {
      try {
        this.observer = new PerformanceObserver((list) => {
          this.longTasks += list.getEntries().length;
          this.ui.setLongTasks(this.longTasks);
        });
        this.observer.observe({ entryTypes: ['longtask'] });
      } catch (_) { /* 旧浏览器无 longtask */ }
    }
  }
}
