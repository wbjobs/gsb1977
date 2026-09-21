# 大计算分片 · 空闲执行 · 可中断 · 进度（requestIdleCallback + Web Worker + Canvas）

以曼德博集合渲染作为「大计算」负载：整幅画布按 16/32/64 px 切成大量分片，
分片可在 Worker 并行计算、在浏览器空闲时分发、随时可中断，并按像素精确汇报进度。

## 运行

直接用浏览器打开 `index.html` 即可（Worker 由 Blob URL 内联生成，`file://` 下也可用）。
也可用任意静态服务器：`npx serve .` 或 `python3 -m http.server`。

## 文件结构

- `index.html` — 控制面板、Canvas、实时指标与事件日志
- `src/mandelbrot.js` — 纯计算：单像素迭代、单片像素生成、Worker 源码构造（Worker 与主线程共用一份代码）
- `src/idle-scheduler.js` — `requestIdleCallback` 封装，无 RIC 时降级 `setTimeout`
- `src/worker-pool.js` — Worker 池：Blob Worker、启动探测与超时、崩溃检测、Transferable 回传
- `src/renderer.js` — 编排：分片切分/交错入队、空闲分发、并发控制、取消、像素加权进度、重试、降级、绘制、指标
- `src/main.js` — UI 绑定、日志、画布点击缩放

## 四项核心需求如何实现

| 需求 | 实现 |
| --- | --- |
| 分片 | 画布切成 N×N tile，交错入队（先出稀疏位置的片，渐进画面更均匀）；片大小、迭代上限可调 |
| 空闲执行 | 主线程只在 `requestIdleCallback` 回调里分发任务，不占用交互帧；不支持 RIC 的浏览器降级 `setTimeout(1)` |
| 可中断 | 「中断」为协作式取消：generation 版本号作废全部迟到结果；停止入队并终止 Worker；主线程降级路径每 4 个扫描行设异步检查点，在片内即停（单片占用 ≤ ~4ms 后让出事件循环） |
| 进度 | 按像素加权（`已完成像素 / 总像素`），边片尺寸不同也准确；失败片扣除已计像素，进度永不超 100% |

## 性能

- 重计算全部在 Worker 线程，Worker 数默认 `hardwareConcurrency - 1`（可手动 1–8）。
- 像素缓冲以 `postMessage(buf, [buffer])` 零拷贝 Transferable 回传。
- 每个 Worker 预取 2 个分片，降低调度空隙；Canvas 逐片 `putImageData` 渐进呈现。
- 面板实时显示 FPS、长任务数（`PerformanceObserver(longtask)`）、吞吐（px/s）、耗时，便于验证「不阻塞 UI」。

## 异常与降级

1. 不支持/无法创建 Worker、Worker 启动 1.5s 无响应 → 自动切换主线程分片模式（空闲切片 + 扫描行检查点）。
2. Worker 运行中崩溃（onerror）→ 在途分片失败，整体降级主线程继续，已完成画面保留。
3. 单片瞬时异常 → 队尾自动重试 2 次；仍失败则该片标红，进度照常，可用「重试失败片」补齐。
4. Canvas 上下文异常 → 记录错误日志，不中断整体流程。
5. 页面提供「强制主线程」「注入瞬时异常（8%）」「模拟 Worker 崩溃」三个故障开关，可直接演示降级链路。

## 验收对照

- **不阻塞 UI**：Worker 模式下主线程仅做空闲分发；计算期间操作控件、点击画布流畅，FPS 稳定、长任务为 0。
- **可中断**：任意时刻点击「中断」，立即停止分发、终止 Worker、丢弃迟到结果，按钮立即恢复。
- **进度准确**：百分比按像素加权；1600×1000、非整除片尺寸下终点恰为 100%；中断时停在真实完成像素。
- **性能可接受**：960×600 / 500 迭代 / 4 Worker 下多 Worker 并行，吞吐面板实时可见；片大小可在 16/32/64 间调优。
- **异常有降级**：上述五类异常均有自动降级或显式标记，事件日志全程可追溯。
