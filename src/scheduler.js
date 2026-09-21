/**
 * IdleShardScheduler
 * - 分片：任务 = shard 描述数组，逐片执行
 * - 空闲：requestIdleCallback 调度（无则降级 setTimeout），空闲时间不足则让出
 * - 中断：pause / resume / cancel，代际号(gen)丢弃过期结果
 * - 进度：完成片数 / 总片数，回调上报
 * - 性能：Worker 池 + Transferable 零拷贝；主线程降级模式按行微切片
 * - 异常：Worker 创建失败 / onerror / 计算抛错 → 自动降级主线程空闲计算
 */
(function (global) {
  'use strict';

  var requestIdle = global.requestIdleCallback || function (cb) {
    return setTimeout(function () { cb({ timeRemaining: function () { return 8; }, didTimeout: false }); }, 1);
  };
  var cancelIdle = global.cancelIdleCallback || clearTimeout;

  var MIN_IDLE_BUDGET_MS = 6;   // 空闲预算低于该值不再派发，避免侵占帧时间
  var FALLBACK_ROWS_PER_TICK = 2; // 主线程降级模式每次空闲tick计算的微切片行数
  var MAX_WORKER_ERRORS = 3;    // 单个 Worker 连续错误超过则永久弃用

  function IdleShardScheduler(options) {
    this.workerUrl = options.workerUrl;
    this.workerCount = options.workerCount || Math.max(1, (navigator.hardwareConcurrency || 4) - 1);
    this.onShard = options.onShard;     // (shard, payload, result) => void
    this.onProgress = options.onProgress; // (done, total, stats) => void
    this.onStateChange = options.onStateChange || function () {};
    this.onModeChange = options.onModeChange || function () {};

    this.state = 'idle'; // idle | running | paused
    this.gen = 0;
    this.queue = [];
    this.total = 0;
    this.done = 0;
    this.workers = [];
    this.mode = 'worker'; // worker | main-thread
    this.idleHandle = null;
    this.stats = { shardMs: [], startedAt: 0 };
    this._fallbackSlice = null; // 主线程降级时的行级续算上下文
  }

  IdleShardScheduler.prototype._spawnWorkers = function () {
    this.workers = [];
    for (var i = 0; i < this.workerCount; i++) {
      try {
        var w = new Worker(this.workerUrl);
        w._busy = false;
        w._errors = 0;
        w.onmessage = this._onWorkerMessage.bind(this, w);
        w.onerror = this._onWorkerError.bind(this, w);
        this.workers.push(w);
      } catch (err) {
        break; // 创建失败（如 file:// 限制）→ 用已创建的，或整体降级
      }
    }
    if (this.workers.length === 0) this._degrade('worker-unavailable');
  };

  IdleShardScheduler.prototype._degrade = function (reason) {
    if (this.mode === 'main-thread') return;
    this.mode = 'main-thread';
    this.workers.forEach(function (w) { try { w.terminate(); } catch (e) {} });
    this.workers = [];
    this.onModeChange('main-thread', reason);
  };

  IdleShardScheduler.prototype._onWorkerError = function (worker, evt) {
    worker._errors++;
    worker._busy = false;
    if (worker._errors >= MAX_WORKER_ERRORS) {
      var idx = this.workers.indexOf(worker);
      if (idx >= 0) this.workers.splice(idx, 1);
      try { worker.terminate(); } catch (e) {}
      if (this.workers.length === 0) this._degrade('worker-error');
    }
    if (this.state === 'running') this._schedule();
  };

  IdleShardScheduler.prototype._onWorkerMessage = function (worker, e) {
    var msg = e.data;
    worker._busy = false;
    if (msg.gen !== this.gen) return; // 过期代际，丢弃
    if (msg.type === 'error') {
      this._onWorkerError(worker, msg);
      // 失败的分片重新入队（由其他 Worker 或降级路径重试）
      this.queue.unshift(msg.id);
      return;
    }
    this._completeShard(msg.id, msg.buffer, msg.meta);
    if (this.state === 'running') this._schedule();
  };

  IdleShardScheduler.prototype._completeShard = function (id, buffer, meta) {
    var shard = this._shards[id];
    this.done++;
    this.stats.shardMs.push(meta.ms);
    this.onShard(shard, buffer, meta);
    this.onProgress(this.done, this.total, this._snapshotStats());
    if (this.done >= this.total) this._finish();
  };

  IdleShardScheduler.prototype._snapshotStats = function () {
    var arr = this.stats.shardMs;
    var avg = arr.length ? arr.reduce(function (a, b) { return a + b; }, 0) / arr.length : 0;
    return {
      avgShardMs: avg,
      elapsedMs: performance.now() - this.stats.startedAt,
      mode: this.mode,
      workers: this.workers.length
    };
  };

  IdleShardScheduler.prototype._finish = function () {
    this.state = 'idle';
    this.onStateChange('done');
  };

  /** 启动一批分片任务。shards: 任意描述数组，executor 需能消费 */
  IdleShardScheduler.prototype.run = function (shards) {
    this.cancel();
    this.gen++;
    this._shards = shards;
    this.total = shards.length;
    this.done = 0;
    this.queue = shards.map(function (_, i) { return i; });
    this.stats = { shardMs: [], startedAt: performance.now() };
    if (this.mode === 'worker' && this.workers.length === 0) this._spawnWorkers();
    this.state = 'running';
    this.onStateChange('running');
    this._schedule();
  };

  IdleShardScheduler.prototype.pause = function () {
    if (this.state !== 'running') return;
    this.state = 'paused';
    if (this.idleHandle !== null) { cancelIdle(this.idleHandle); this.idleHandle = null; }
    this.onStateChange('paused');
  };

  IdleShardScheduler.prototype.resume = function () {
    if (this.state !== 'paused') return;
    this.state = 'running';
    this.onStateChange('running');
    this._schedule();
  };

  IdleShardScheduler.prototype.cancel = function () {
    this.gen++; // 使在途结果失效
    this.queue = [];
    this.total = 0;
    this.done = 0;
    this._fallbackSlice = null;
    if (this.idleHandle !== null) { cancelIdle(this.idleHandle); this.idleHandle = null; }
    if (this.state !== 'idle') {
      this.state = 'idle';
      this.onStateChange('cancelled');
    }
  };

  IdleShardScheduler.prototype._schedule = function () {
    if (this.state !== 'running' || this.idleHandle !== null) return;
    var self = this;
    this.idleHandle = requestIdle(function (deadline) {
      self.idleHandle = null;
      self._pump(deadline);
    }, { timeout: 100 });
  };

  IdleShardScheduler.prototype._pump = function (deadline) {
    if (this.state !== 'running') return;
    if (this.mode === 'worker') this._pumpWorkers(deadline);
    else this._pumpMainThread(deadline);
    if (this.state === 'running' && (this.queue.length > 0 || this._fallbackSlice)) this._schedule();
  };

  IdleShardScheduler.prototype._pumpWorkers = function (deadline) {
    // 空闲预算内尽量把空闲 Worker 喂满；派发本身廉价，主要防止超时回调里过度派发
    while (this.queue.length > 0 && (deadline.timeRemaining() > MIN_IDLE_BUDGET_MS || deadline.didTimeout)) {
      var w = null;
      for (var i = 0; i < this.workers.length; i++) {
        if (!this.workers[i]._busy) { w = this.workers[i]; break; }
      }
      if (!w) break;
      var id = this.queue.shift();
      w._busy = true;
      try {
        w.postMessage({ type: 'shard', id: id, gen: this.gen, payload: this._shards[id] });
      } catch (err) {
        w._busy = false;
        this.queue.unshift(id);
        this._onWorkerError(w, err);
        break;
      }
    }
  };

  /** 主线程降级：严格在空闲预算内按行微切片计算，可随时让出 */
  IdleShardScheduler.prototype._pumpMainThread = function (deadline) {
    while (deadline.timeRemaining() > MIN_IDLE_BUDGET_MS || (deadline.didTimeout && !this._fallbackSlice)) {
      if (!this._fallbackSlice) {
        if (this.queue.length === 0) return;
        var id = this.queue.shift();
        this._fallbackSlice = { id: id, row: 0, buf: new Uint8ClampedArray(0) };
      }
      var slice = this._fallbackSlice;
      var shard = this._shards[slice.id];
      var t0 = performance.now();
      try {
        // 每次只算 FALLBACK_ROWS_PER_TICK 行，剩余行留到下一个空闲tick
        var part = Mandelbrot.computeShardRows(shard, slice.row, FALLBACK_ROWS_PER_TICK, slice.buf);
        slice.buf = part.buf;
        slice.row = part.nextRow;
      } catch (err) {
        this.onStateChange('error', String(err && err.message || err));
        this._fallbackSlice = null;
        continue; // 跳过坏分片，继续队列，避免整体卡死
      }
      if (slice.row >= shard.height) {
        var ms = performance.now() - t0;
        var id2 = slice.id;
        this._fallbackSlice = null;
        this._completeShard(id2, slice.buf.buffer, { ms: ms, engine: 'main-thread' });
      }
      if (deadline.timeRemaining() <= MIN_IDLE_BUDGET_MS && !deadline.didTimeout) return;
    }
  };

  IdleShardScheduler.prototype.destroy = function () {
    this.cancel();
    this.workers.forEach(function (w) { try { w.terminate(); } catch (e) {} });
    this.workers = [];
  };

  global.IdleShardScheduler = IdleShardScheduler;
})(typeof self !== 'undefined' ? self : this);
