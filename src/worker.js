/* 经典 Worker：可被 importScripts 复用内核；异常通过 error 消息上报，由调度器降级 */
importScripts('mandelbrot.js');

self.onmessage = function (e) {
  const msg = e.data;
  if (msg.type !== 'shard') return;
  const t0 = performance.now();
  try {
    const buf = Mandelbrot.computeShard(msg.payload);
    const ms = performance.now() - t0;
    self.postMessage(
      { type: 'result', id: msg.id, gen: msg.gen, buffer: buf.buffer, meta: { ms: ms, engine: 'worker' } },
      [buf.buffer]
    );
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, gen: msg.gen, message: String(err && err.message || err) });
  }
};
