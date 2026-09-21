# 大计算分片调度演示

以 Mandelbrot 大图渲染为样例，演示 **分片 + 空闲执行 + 可中断 + 进度上报** 的大计算调度方案。

## 运行

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000
```

（Web Worker 需要 http(s) 环境；若用 `file://` 打开，会自动降级到主线程空闲计算，功能仍可用。）

## 技术方案

| 需求 | 实现 |
| --- | --- |
| 分片 | 图像按行带切为 40 个分片（`SHARD_ROWS=16`），逐片计算、逐片上屏 |
| 空闲 | `requestIdleCallback` 派发，空闲预算 < 6ms 即让出；无 rIC 时降级 `setTimeout` |
| 中断 | `pause / resume / cancel`；代际号（gen）使取消后在途结果自动失效 |
| 进度 | 完成片数 / 总片数，单调递增，附平均分片耗时与总耗时 |
| 性能 | Worker 池（`hardwareConcurrency - 1`）+ Transferable 零拷贝回传 |
| 异常 | Worker 创建失败 / onerror / 计算抛错 → 自动降级主线程行级微切片计算；坏分片跳过不卡死 |

## 文件

- `src/scheduler.js` — 调度器核心（分片队列、空闲泵、Worker 池、降级、代际取消）
- `src/mandelbrot.js` — 共享计算内核，Worker 与主线程降级路径共用，保证结果一致
- `src/worker.js` — 经典 Worker，异常通过 `error` 消息上报
- `src/main.js` / `index.html` — UI：进度条、fps 指示、动画小球、主线程繁忙模拟

## 验收对照

- **不阻塞 UI**：计算只在空闲回调中派发/执行；页面有实时 fps 与动画小球可直观验证，"模拟主线程繁忙"开关可验证负载下自动让出
- **可中断**：暂停后进度冻结，继续后从断点恢复；取消后立即停止且无残留回调
- **进度准确**：`done/total` 实时更新，单调不减，完成时精确 100%
- **性能可接受**：多 Worker 并行 + ArrayBuffer 转移，统计面板显示平均分片耗时
- **异常有降级**：勾选"强制降级"或以 `file://` 打开可验证主线程空闲计算路径
