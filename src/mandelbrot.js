// 纯计算模块：同一份源码既运行在 Worker 内，也用于主线程降级。
// 通过函数 toString() 注入 Worker（Blob Worker），因此 file:// 直接打开也可用。

export function iterateMandelbrot(cx, cy, maxIter) {
  let x = 0;
  let y = 0;
  let x2 = 0;
  let y2 = 0;
  let iter = 0;
  while (x2 + y2 <= 4 && iter < maxIter) {
    y = 2 * x * y + cy;
    x = x2 - y2 + cx;
    x2 = x * x;
    y2 = y * y;
    iter++;
  }
  if (iter >= maxIter) return -1; // 集合内部
  // 平滑迭代值
  const logZn = Math.log(x2 + y2) / 2;
  const nu = Math.log(logZn / Math.log(2)) / Math.log(2);
  return iter + 1 - nu;
}

function putPixel(out, idx, smooth) {
  if (smooth < 0) {
    out[idx] = 8; out[idx + 1] = 10; out[idx + 2] = 26; out[idx + 3] = 255;
    return;
  }
  const h = (Math.sqrt(smooth) * 0.06 + 0.62) % 1;
  const s = 0.72;
  const l = smooth < 2 ? smooth / 2 * 0.5 : 0.5 + 0.5 * Math.sin(smooth * 0.08);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h * 6;
  const xh = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = xh; }
  else if (hp < 2) { r = xh; g = c; }
  else if (hp < 3) { g = c; b = xh; }
  else if (hp < 4) { g = xh; b = c; }
  else if (hp < 5) { r = xh; b = c; }
  else { r = c; b = xh; }
  const m = l - c / 2;
  out[idx] = (r + m) * 255;
  out[idx + 1] = (g + m) * 255;
  out[idx + 2] = (b + m) * 255;
  out[idx + 3] = 255;
}

/**
 * 计算一个分片（tile）。
 * @param {object} p { tile:{x,y,w,h}, width,height, view:{cx,cy,zoom}, maxIter, failRate }
 * @param {Function|null} checkpoint 每扫描行回调 (linesDone) => boolean，
 *        返回 false 表示应协作式中断（放弃结果）。
 * @returns {Uint8ClampedArray|null} RGBA 像素；被中断时返回 null
 */
export function tilePixels(p, checkpoint) {
  const { tile, width, height, view, maxIter, failRate } = p;
  const aspect = width / height;
  const scale = 3.2 / view.zoom;
  const out = new Uint8ClampedArray(tile.w * tile.h * 4);
  let idx = 0;
  for (let ly = 0; ly < tile.h; ly++) {
    const py = tile.y + ly;
    const cy = (py / height - 0.5) * scale + view.cy;
    for (let lx = 0; lx < tile.w; lx++) {
      const px = tile.x + lx;
      const cx = (px / width - 0.5) * scale * aspect + view.cx;
      putPixel(out, idx, iterateMandelbrot(cx, cy, maxIter));
      idx += 4;
    }
    if (checkPresent(failRate, tile, ly)) {
      const err = new Error('分片计算注入异常');
      err.code = 'INJECTED';
      throw err;
    }
    if (checkpoint && (ly & 3) === 3) {
      const cont = checkpoint(ly + 1);
      if (cont && typeof cont.then === 'function') {
        // 主线程异步检查点：让出事件循环后再决定是否继续
        return cont.then((keepGoing) => keepGoing ? continueTile(out, idx, ly + 1, p, checkpoint) : null);
      }
      if (!cont) return null;
    }
  }
  return out;
}

// 仅在启用错误注入时，按概率抛出，且只在片的前几行抛出（瞬时失败可被重试解决）
function checkPresent(failRate, tile, ly) {
  if (!failRate || ly !== 2) return false;
  const seed = Math.sin(tile.x * 12.9898 + tile.y * 78.233) * 43758.5453;
  return (seed - Math.floor(seed)) < failRate;
}


// 异步检查点后从断点继续扫描（主线程降级路径使用）
function continueTile(out, idx, startLy, p, checkpoint) {
  const { tile, width, height, view, maxIter, failRate } = p;
  const aspect = width / height;
  const scale = 3.2 / view.zoom;
  for (let ly = startLy; ly < tile.h; ly++) {
    const py = tile.y + ly;
    const cy = (py / height - 0.5) * scale + view.cy;
    for (let lx = 0; lx < tile.w; lx++) {
      const px = tile.x + lx;
      const cx = (px / width - 0.5) * scale * aspect + view.cx;
      putPixel(out, idx, iterateMandelbrot(cx, cy, maxIter));
      idx += 4;
    }
    if (checkPresent(failRate, tile, ly)) {
      const err = new Error('分片计算注入异常');
      err.code = 'INJECTED';
      throw err;
    }
    if (checkpoint && (ly & 3) === 3) {
      const cont = checkpoint(ly + 1);
      if (cont && typeof cont.then === 'function') {
        return cont.then((keepGoing) => keepGoing ? continueTile(out, idx, ly + 1, p, checkpoint) : null);
      }
      if (!cont) return null;
    }
  }
  return out;
}

// 构造 Worker 源码：注入纯函数 + 消息循环。
export function buildWorkerSource() {
  const deps = iterateMandelbrot.toString() + '\n' + putPixel.toString() + '\n'
    + tilePixels.toString() + '\n' + continueTile.toString() + '\n' + checkPresent.toString() + '\n';
  return `
'use strict';
${deps}
let currentId = null;
self.onmessage = function (e) {
  const msg = e.data;
  if (msg.type === 'die') { self.close(); return; }
  if (msg.type !== 'run') return;
  currentId = msg.id;
  try {
    const pixels = tilePixels(msg.payload, null);
    self.postMessage(
      { type: 'done', id: msg.id, buffer: pixels.buffer, w: msg.payload.tile.w, h: msg.payload.tile.h },
      [pixels.buffer]
    );
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String(err && err.message || err) });
  } finally {
    currentId = null;
  }
};
`;
}
