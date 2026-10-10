/**
 * Service Worker —— 让整站（含中国象棋引擎）首屏加载后断网可用。
 *
 * 缓存策略（三条，按资源类型分开，避免「更新困难」）：
 *   1. 预缓存清单（页面骨架 / 样式 / 全部脚本 / godogpaw.wasm / 字体 / 图标）
 *      → install 时一次装好；fetch 走 **cache-first**，因为这些都是带版本号的文件
 *   2. 导航请求（HTML 文档）→ **network-first**，拿不到再回缓存
 *      → 这样刷新页面一定先看到最新 HTML，断网才用旧的，不会「更新不动」
 *   3. 其他同源 GET → cache-first 补齐写回
 *
 * 版本更新：改动 CACHE_VERSION 或预缓存清单会让旧缓存在 activate 阶段整体删除。
 * 页面侧 js/sw-register.js 会提示「有新版本」，用户确认后 skipWaiting 立即生效。
 */

const CACHE_VERSION = 'v3';
const CACHE_NAME = `toolbox-${CACHE_VERSION}`;

const PRECACHE = [
  './',
  './index.html',
  './css/style.css',
  './vendor/fonts.css',
  './vendor/iconify-lite.js',
  './vendor/icons/mdi-sprite.svg',

  './js/main.js',
  './js/fingerprint.js',
  './js/lucky.js',
  './js/crypto-tools.js',
  './js/gomoku.js',
  './js/gomoku-worker.js',
  './js/gomoku-engine/board.js',
  './js/gomoku-engine/cache.js',
  './js/gomoku-engine/config.js',
  './js/gomoku-engine/eval.js',
  './js/gomoku-engine/minmax.js',
  './js/gomoku-engine/position.js',
  './js/gomoku-engine/shape.js',
  './js/gomoku-engine/zobrist.js',
  './js/chess-bridge.js',
  './js/chess-book.js',
  './js/chess.js',
  './js/chess-worker.js',
  './js/chess-engine/chess.js',
  './js/lib/stockfish.js',
  './js/lib/stockfish.wasm',
  './js/lib/godogpaw/godogpaw-bridge.js',
  './js/lib/godogpaw/wasm_exec.js',
  './js/lib/godogpaw/godogpaw.wasm',
  './js/xiangqi.js',
  './js/sw-register.js',

  './img/chess/wK.svg', './img/chess/wQ.svg', './img/chess/wR.svg',
  './img/chess/wB.svg', './img/chess/wN.svg', './img/chess/wP.svg',
  './img/chess/bK.svg', './img/chess/bQ.svg', './img/chess/bR.svg',
  './img/chess/bB.svg', './img/chess/bN.svg', './img/chess/bP.svg',

  // 首页配图（已本地化，原来是 picsum.photos 外链）
  './img/home/chess-desk.webp',
  './img/home/chess-board.webp',
  './img/home/gomoku-stone.webp',
  './img/home/xiangqi-board.webp',
  './img/home/padlock.webp',
];

// 字体文件太多且名字带序号，install 时按 fonts.css 里出现的文件动态补全
const FONT_DIR = './vendor/fonts/';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const urls = new Set(PRECACHE);
    try {
      const css = await fetch('./vendor/fonts.css', { cache: 'no-cache' });
      if (css.ok) {
        const text = await css.text();
        for (const m of text.matchAll(/url\('([^']+)'\)/g)) {
          urls.add(new URL(m[1].replace(/^fonts\//, FONT_DIR), self.registration.scope).href);
        }
      }
    } catch (e) {
      console.warn('[sw] 读取 fonts.css 失败，字体改由运行时缓存:', e.message);
    }
    // 逐个 add，单个失败不影响整体（比如某个字体这次没取到）
    await Promise.all([...urls].map(async (u) => {
      try { await cache.add(new Request(u, { cache: 'reload' })); }
      catch (e) { console.warn('[sw] 预缓存失败:', u, e.message); }
    }));
    console.log('[sw] 预缓存完成，共', urls.size, '项 →', CACHE_NAME);
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => {
      console.log('[sw] 清理旧缓存:', n);
      return caches.delete(n);
    }));
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.disable(); } catch { /* 忽略 */ }
    }
    await self.clients.claim();
    console.log('[sw] 已接管，当前缓存:', CACHE_NAME);
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function isNavigation(request) {
  return request.mode === 'navigate'
    || (request.method === 'GET' && request.headers.get('accept')?.includes('text/html'));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // 站外一律不管（本站已无 CDN 依赖）

  // 1) HTML 文档：network-first，断网回退缓存
  if (isNavigation(request)) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, fresh.clone());
        return fresh;
      } catch {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;
        const shell = await caches.match('./index.html');
        if (shell) return shell;
        return new Response('离线，且缓存里没有这个页面。', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })());
    return;
  }

  // 2) 其他同源 GET：cache-first，命中就返回；未命中取网络并写回
  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: false });
    if (cached) return cached;
    try {
      const fresh = await fetch(request);
      if (fresh && fresh.ok && fresh.type === 'basic') {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, fresh.clone());
      }
      return fresh;
    } catch (e) {
      // wasm / 脚本取不到时给出明确错误，别让页面拿到空响应
      console.warn('[sw] 离线且无缓存:', request.url);
      return new Response('', { status: 504, statusText: 'Offline and not cached' });
    }
  })());
});
