(function () {
  'use strict';

  var canvas = document.getElementById('view');
  var ctx = canvas.getContext('2d');
  var bar = document.getElementById('bar');
  var pct = document.getElementById('pct');
  var statusEl = document.getElementById('status');
  var statsEl = document.getElementById('stats');
  var btnStart = document.getElementById('btn-start');
  var btnPause = document.getElementById('btn-pause');
  var btnCancel = document.getElementById('btn-cancel');
  var btnJank = document.getElementById('btn-jank');
  var chkForceFallback = document.getElementById('chk-fallback');

  var WIDTH = 960, HEIGHT = 640;
  var SHARD_ROWS = 16; // 每片 16 行 → 40 个分片
  canvas.width = WIDTH;
  canvas.height = HEIGHT;

  var view = { cx: -0.6, cy: 0, scale: 1 };
  var maxIter = 500;

  function buildShards() {
    var shards = [];
    for (var y = 0; y < HEIGHT; y += SHARD_ROWS) {
      shards.push({
        x: 0, y: y, width: WIDTH,
        height: Math.min(SHARD_ROWS, HEIGHT - y),
        fullWidth: WIDTH, fullHeight: HEIGHT,
        view: view, maxIter: maxIter
      });
    }
    return shards;
  }

  var scheduler = new IdleShardScheduler({
    workerUrl: 'src/worker.js',
    onShard: function (shard, buffer) {
      var img = new ImageData(new Uint8ClampedArray(buffer), shard.width, shard.height);
      ctx.putImageData(img, shard.x, shard.y);
    },
    onProgress: function (done, total, stats) {
      var p = total ? Math.round((done / total) * 100) : 0;
      bar.style.width = p + '%';
      pct.textContent = p + '% (' + done + '/' + total + ')';
      statsEl.textContent =
        '模式: ' + (stats.mode === 'worker' ? 'Worker × ' + stats.workers : '主线程空闲降级') +
        ' | 平均分片: ' + stats.avgShardMs.toFixed(1) + 'ms' +
        ' | 已耗时: ' + (stats.elapsedMs / 1000).toFixed(1) + 's';
    },
    onStateChange: function (state, detail) {
      statusEl.textContent = {
        running: '运行中', paused: '已暂停', done: '完成',
        cancelled: '已取消', error: '分片错误(已跳过): ' + detail
      }[state] || state;
      btnPause.textContent = state === 'paused' ? '继续' : '暂停';
      btnStart.disabled = state === 'running';
    },
    onModeChange: function (mode, reason) {
      statusEl.textContent = '已降级到主线程空闲计算 (' + reason + ')';
    }
  });

  if (chkForceFallback.checked === false && !window.Worker) {
    chkForceFallback.checked = true;
    chkForceFallback.disabled = true;
  }

  btnStart.onclick = function () {
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    if (chkForceFallback.checked) scheduler._degrade('manual');
    scheduler.run(buildShards());
  };
  btnPause.onclick = function () {
    if (scheduler.state === 'running') scheduler.pause();
    else scheduler.resume();
  };
  btnCancel.onclick = function () { scheduler.cancel(); };

  // 交互验证"不阻塞 UI"：点击画布放大重算；动画小球持续转动
  canvas.addEventListener('click', function (e) {
    var r = canvas.getBoundingClientRect();
    var planeW = 3.5 * view.scale;
    var planeH = planeW * (HEIGHT / WIDTH);
    view = {
      cx: view.cx - planeW / 2 + (e.clientX - r.left) / WIDTH * planeW,
      cy: view.cy - planeH / 2 + (e.clientY - r.top) / HEIGHT * planeH,
      scale: view.scale * 0.5
    };
    maxIter = Math.min(2000, maxIter + 100);
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    scheduler.run(buildShards());
  });

  // 制造主线程占用的开关：验证空闲调度在负载下自动让出
  var jankTimer = null;
  btnJank.onclick = function () {
    if (jankTimer) { clearInterval(jankTimer); jankTimer = null; btnJank.textContent = '模拟主线程繁忙'; return; }
    jankTimer = setInterval(function () {
      var end = performance.now() + 30;
      while (performance.now() < end) {} // 每 50ms 阻塞 30ms
    }, 50);
    btnJank.textContent = '停止模拟繁忙';
  };

  // FPS 指示器：证明 UI 不被计算阻塞
  var ball = document.getElementById('ball');
  var frames = 0, lastFpsAt = performance.now();
  var fpsEl = document.getElementById('fps');
  (function tick(t) {
    frames++;
    if (t - lastFpsAt >= 1000) {
      fpsEl.textContent = frames + ' fps';
      frames = 0; lastFpsAt = t;
    }
    ball.style.transform = 'translateX(' + (40 + 35 * Math.sin(t / 300)) + 'px)';
    requestAnimationFrame(tick);
  })(performance.now());
})();
