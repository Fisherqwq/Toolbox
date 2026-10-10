/**
 * Service Worker 注册。
 *
 * 只在 http/https 下注册：file:// 协议不支持 SW（页面里另有提示）。
 * 更新策略：新 SW 进入 waiting 时，页面顶部浮出一条提示条，用户点「刷新」才切换
 * —— 避免正在下棋时被强制刷新打断。
 */
(function () {
  'use strict';

  if (!('serviceWorker' in navigator)) {
    console.warn('[sw] 这个浏览器不支持 Service Worker，离线功能不可用');
    return;
  }
  if (location.protocol === 'file:') {
    console.warn('[sw] file:// 下不注册 Service Worker；离线请用 HTTP 打开（python tools/serve.py 8000）');
    return;
  }

  function showUpdateBar(onReload) {
    if (document.getElementById('swUpdateBar')) return;
    const bar = document.createElement('div');
    bar.id = 'swUpdateBar';
    bar.setAttribute('role', 'status');
    bar.innerHTML =
      '<span>页面有新版本了。正在下棋的话可以下完再刷新。</span>' +
      '<button type="button" id="swUpdateBtn">立即刷新</button>' +
      '<button type="button" id="swUpdateClose" aria-label="关闭">×</button>';
    document.body.appendChild(bar);
    document.getElementById('swUpdateBtn').addEventListener('click', onReload);
    document.getElementById('swUpdateClose').addEventListener('click', () => bar.remove());
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then((reg) => {
      console.log('[sw] 注册成功，scope =', reg.scope);

      // 有新 SW 进入 installed 且旧 SW 还在控制页面 → 提示用户刷新切换
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBar(() => { sw.postMessage({ type: 'SKIP_WAITING' }); location.reload(); });
          }
        });
      });

      // 新 SW 接管后刷新一次，确保页面拿到新资源。
      // ⚠ 必须区分「首次安装接管」和「更新接管」：
      //   首次安装时页面本来就在用网络资源，SW 接管不影响正确性，
      //   如果这里也 reload，首次访问就会白白重载一次 ——
      //   实测症状是打开页面后头几百毫秒内的点击全部落空（引擎正在重新加载）。
      //   只有「已经有旧 SW 在控制本页、现在换成新的」才需要刷新。
      let controlledAtLoad = !!navigator.serviceWorker.controller;
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded || !controlledAtLoad) return;
        reloaded = true;
        console.log('[sw] 新版本已接管，刷新页面');
        location.reload();
      });
    }).catch((e) => {
      console.warn('[sw] 注册失败（不影响在线使用）:', e.message);
    });
  });
})();
