/* 共享计算内核：Worker (importScripts) 与主线程降级模式共用，保证两条路径结果一致 */
(function (global) {
  'use strict';

  function colorFor(iter, maxIter) {
    if (iter >= maxIter) return [0, 0, 0];
    const t = iter / maxIter;
    const r = Math.floor(9 * (1 - t) * t * t * t * 255);
    const g = Math.floor(15 * (1 - t) * (1 - t) * t * t * 255);
    const b = Math.floor(8.5 * (1 - t) * (1 - t) * (1 - t) * t * 255);
    return [r, g, b];
  }

  /**
   * 计算分片中 [startRow, startRow+rowCount) 行，写入/复用 buf。
   * 返回 { buf, nextRow }，供主线程降级模式跨空闲 tick 续算。
   */
  function computeShardRows(payload, startRow, rowCount, buf) {
    const { x, y, width, height, view, maxIter, fullWidth, fullHeight } = payload;
    if (!buf || buf.length !== width * height * 4) buf = new Uint8ClampedArray(width * height * 4);
    const endRow = Math.min(height, startRow + rowCount);
    const planeW = 3.5 * view.scale;
    const planeH = planeW * (fullHeight / fullWidth);
    const x0 = view.cx - planeW / 2;
    const y0 = view.cy - planeH / 2;

    for (let row = startRow; row < endRow; row++) {
      const py = y0 + ((y + row) / fullHeight) * planeH;
      let idx = row * width * 4;
      for (let col = 0; col < width; col++) {
        const px = x0 + ((x + col) / fullWidth) * planeW;
        let zx = 0, zy = 0, iter = 0;
        while (zx * zx + zy * zy <= 4 && iter < maxIter) {
          const t = zx * zx - zy * zy + px;
          zy = 2 * zx * zy + py;
          zx = t;
          iter++;
        }
        const c = colorFor(iter, maxIter);
        buf[idx] = c[0]; buf[idx + 1] = c[1]; buf[idx + 2] = c[2]; buf[idx + 3] = 255;
        idx += 4;
      }
    }
    return { buf, nextRow: endRow };
  }

  /** 整片计算（Worker 路径） */
  function computeShard(payload) {
    return computeShardRows(payload, 0, payload.height, null).buf;
  }

  global.Mandelbrot = { computeShard, computeShardRows };
})(typeof self !== 'undefined' ? self : this);
