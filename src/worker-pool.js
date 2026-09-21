// Worker 池：创建/复用 Blob Worker，分发分片，回收结果。
// Worker 启动 1.5s 内不可用即视为启动失败（由上层降级主线程）。

import { buildWorkerSource } from './mandelbrot.js';

const READY_TIMEOUT_MS = 1500;

export class WorkerPool {
  constructor(size, { onLog } = {}) {
    this.onLog = onLog || (() => {});
    this.size = size;
    this.workers = [];
    this.free = [];
    this.waiting = [];
    this.crashed = false;
    this.nextId = 1;
    this.pending = new Map();
    this.url = null;
    this.terminated = false;
  }

  async init() {
    if (typeof Worker === 'undefined') throw new Error('当前环境不支持 Web Worker');
    const blob = new Blob([buildWorkerSource()], { type: 'application/javascript' });
    this.url = URL.createObjectURL(blob);
    const created = await Promise.all(
      Array.from({ length: this.size }, (_, i) => this._create(i))
    );
    const alive = created.filter(Boolean);
    if (alive.length === 0) throw new Error('所有 Worker 均启动失败');
    if (alive.length < this.size) {
      this.onLog('warn', `${this.size - alive.length} 个 Worker 启动失败，以 ${alive.length} 个继续`);
    }
    this.size = alive.length;
    this.workers = alive;
    this.free = alive.slice();
  }

  _create(index) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { worker.terminate(); } catch (_) {}
        resolve(null);
      }, READY_TIMEOUT_MS);
      let worker;
      try {
        worker = new Worker(this.url);
      } catch (err) {
        clearTimeout(timer);
        resolve(null);
        return;
      }
      const slot = { worker, index };
      worker.onmessage = (e) => this._onMessage(slot, e.data);
      worker.onerror = (e) => {
        this._onCrash(slot, e.message || 'Worker 运行时错误');
        if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
      };
      // 发出存活探测：用一个 1×1 分片验证 Worker 可正常响应
      const probeId = -index - 1;
      this.pending.set(probeId, {
        resolve: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(slot);
        },
        reject: () => {},
      });
      worker.postMessage({
        type: 'run',
        id: probeId,
        payload: {
          tile: { x: 0, y: 0, w: 1, h: 1 },
          width: 1, height: 1, view: { cx: -0.5, cy: 0, zoom: 1 },
          maxIter: 2, failRate: 0,
        },
      });
    });
  }

  _onMessage(slot, msg) {
    if (msg.type === 'error') {
      const job = this.pending.get(msg.id);
      if (job) { this.pending.delete(msg.id); job.reject(new Error(msg.message)); this._release(slot); }
      return;
    }
    if (msg.type === 'done') {
      const job = this.pending.get(msg.id);
      if (job) {
        this.pending.delete(msg.id);
        job.resolve({ buffer: msg.buffer, w: msg.w, h: msg.h });
        this._release(slot);
      }
      return;
    }
  }

  _onCrash(slot, message) {
    if (this.terminated) return;
    this.crashed = true;
    // 拒绝该 Worker 上正在等待的任务，触发上层重试/降级
    for (const [id, job] of this.pending) {
      if (job.slot !== slot) continue;
      this.pending.delete(id);
      const err = new Error(message || 'Worker 崩溃');
      err.crash = true;
      job.reject(err);
    }
    try { slot.worker.terminate(); } catch (_) {}
    this.workers = this.workers.filter((w) => w !== slot);
    this.free = this.free.filter((w) => w !== slot);
  }

  _release(slot) {
    if (this.terminated || !this.workers.includes(slot)) return;
    const next = this.waiting.shift();
    if (next) next.resolve(slot);
    else this.free.push(slot);
  }

  _acquire() {
    if (this.free.length) return Promise.resolve(this.free.pop());
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  /**
   * 运行一个分片。返回 { buffer, w, h }，失败时 reject。
   */
  async run(payload) {
    if (this.terminated) throw new Error('Worker 池已销毁');
    const slot = await this._acquire();
    if (this.terminated || !this.workers.includes(slot)) {
      const err = new Error('Worker 不可用');
      err.crash = true;
      throw err;
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, slot });
      slot.worker.postMessage({ type: 'run', id, payload });
    });
  }

  get alive() { return this.workers.length; }

  terminate() {
    this.terminated = true;
    for (const [, job] of this.pending) {
      job.reject(Object.assign(new Error('Worker 池已销毁'), { aborted: true }));
    }
    this.pending.clear();
    for (const waiter of this.waiting) {
      waiter.reject(Object.assign(new Error('Worker 池已销毁'), { aborted: true, crash: true }));
    }
    this.waiting.length = 0;
    for (const slot of this.workers) {
      try { slot.worker.terminate(); } catch (_) {}
    }
    this.workers = [];
    this.free = [];
    if (this.url) URL.revokeObjectURL(this.url);
  }
}
