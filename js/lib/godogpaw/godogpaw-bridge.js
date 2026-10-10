/**
 * godogpaw 桥接层 —— 把 Go/WASM 引擎暴露的全局函数收成一个可等待的 JS 对象。
 *
 * 引擎来源
 *   js/lib/godogpaw/godogpaw.wasm   Go 编译的 godogpaw UCCI 引擎（4.7 MB）
 *   js/lib/godogpaw/wasm_exec.js    Go 官方胶水（go1.27.1），必须与 wasm 同版本
 *   原始文件、源码仓库在  中国象棋模型\  （原样保留，未改动）
 *
 * 引擎向 window 挂 6 个函数（实测，非推断）：
 *   engineNewGame(fen) / engineGetBoard() / engineGetLegalMovesFrom(sq)
 *   engineDoMoveBySquares(from,to) / engineUndoMove() / engineSearch(depth,ms)
 *
 * ⚠ 引擎缺陷保护（作者待修，前端只做隔离，不改规则）
 *   1. engineNewGame 收到畸形 FEN 时 Go 侧会 panic（index out of range），
 *      整个 runtime 退出，此后所有调用抛 "Go program has already exited"。
 *      → 本层做严格的 FEN 校验 + 白名单，永远不把可疑字符串喂进去。
 *      → 同时用 crashed 状态兜住，一旦发生就把页面切到「引擎已停止」而不是静默假死。
 *   2. engineSearch 可能返回「走后自己老将仍被将」的着法（自爆）。本层不做规则修正，
 *      只在文档里记录复现步骤。
 *
 * ⚠ 坐标约定（三轮校准后确认）
 *   sq = file + rank * 9，rank 0 = 红方底线（画在画布下方），rank 9 = 黑方底线
 *   码值：红 1..7（俥仕炮兵傌相帅）  黑 9..15（车士砲卒马象将）  0 = 空
 *
 * ⚠ engineSearch 语义：返回 Promise<"b2e2">，并且**自己就把棋走掉了**。
 *   所以调用方不要再补一次 doMove，悔棋时也要连撤两步（AI + 自己）。
 */
(function () {
  'use strict';

  const DIR = 'js/lib/godogpaw/';
  const GLUE = DIR + 'wasm_exec.js';
  const WASM = DIR + 'godogpaw.wasm';

  const REQUIRED = [
    'engineNewGame', 'engineGetBoard', 'engineGetLegalMovesFrom',
    'engineDoMoveBySquares', 'engineUndoMove', 'engineSearch',
  ];

  const LOAD_TIMEOUT = 30000;   // 冷启动实测约 0.2s（Node）；30s 是给慢机器/大文件的余量
  const POLL_INTERVAL = 120;
  const SEARCH_WATCHDOG = 120000; // 硬上限：任何一次搜索都不许超过 2 分钟

  const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';
  // 白名单：只允许这几条固定 FEN。界面不提供自定义局面，避免踩引擎的 FEN panic。
  const ALLOWED_FEN = new Set([START_FEN]);

  const isRed = (code) => code >= 1 && code <= 7;
  const isBlack = (code) => code >= 9 && code <= 15;

  let state = 'idle';       // idle | loading | ready | error | crashed
  let lastError = null;
  let loadPromise = null;
  let goRuntime = null;
  let wasmInstance = null;
  let pollTimer = null;
  let searchDepth = 0;

  const listeners = { statechange: [], crash: [] };
  const on = (evt, fn) => { (listeners[evt] || (listeners[evt] = [])).push(fn); };
  const emit = (evt, payload) => { (listeners[evt] || []).forEach((fn) => { try { fn(payload); } catch (e) { console.error('[godogpaw] 监听器抛错:', e); } }); };

  function setState(next, err) {
    state = next;
    if (err) lastError = err;
    emit('statechange', { state, error: lastError });
  }

  function fail(message, err) {
    const e = err instanceof Error ? err : new Error(message);
    if (!e.message) e.message = message;
    console.error('[godogpaw] ' + message, e);
    setState('error', e);
    throw e;
  }

  /** Go runtime 退出后，任何桥接调用都会抛这个错；统一入口把它升级成 crashed 状态 */
  function invoke(name, args) {
    if (state === 'crashed') throw new Error('引擎已停止运行（Go runtime 已退出），请刷新页面重试');
    const fn = window[name];
    if (typeof fn !== 'function') throw new Error(`引擎接口 ${name} 不可用`);
    try {
      return fn.apply(null, args || []);
    } catch (e) {
      if (/Go program has already exited/i.test(e.message || '')) {
        setState('crashed', e);
        emit('crash', { at: name, error: e });
        throw new Error('引擎意外退出（Go runtime 已停止）。请刷新页面重开一局。');
      }
      throw e;
    }
  }

  /* ---------------- FEN 校验 ---------------- */

  /**
   * 校验 FEN，不通过就抛错 —— 绝不让畸形串进到 Go 里。
   * 只做结构校验（10 行、每行 9 格、马/士/相/将数量与走子方合法）。
   */
  function validateFen(fen) {
    if (typeof fen !== 'string' || !fen.trim()) throw new Error('FEN 不能为空');
    if (fen.length > 120) throw new Error('FEN 过长');
    const parts = fen.trim().split(/\s+/);
    if (parts.length < 2) throw new Error('FEN 缺少走子方字段');
    const [boardPart, sidePart] = parts;
    if (sidePart !== 'w' && sidePart !== 'b') throw new Error('FEN 走子方只能是 w 或 b');
    const ranks = boardPart.split('/');
    if (ranks.length !== 10) throw new Error(`FEN 棋盘应为 10 行，实际 ${ranks.length} 行`);

    let totals = { K: 0, A: 0, B: 0, k: 0, a: 0, b: 0 };
    for (let r = 0; r < 10; r++) {
      let files = 0;
      for (const ch of ranks[r]) {
        if (ch >= '1' && ch <= '9') { files += Number(ch); continue; }
        if (!/[rnbakcpRNBAKCP]/.test(ch)) throw new Error(`FEN 第 ${r + 1} 行含非法字符 "${ch}"`);
        files += 1;
        if (ch in totals) totals[ch] += 1;
      }
      if (files !== 9) throw new Error(`FEN 第 ${r + 1} 行是 ${files} 格，应为 9 格`);
    }
    if (totals.K !== 1 || totals.k !== 1) throw new Error('FEN 必须各有 1 个帅与 1 个将');
    if (totals.A > 2 || totals.B > 2 || totals.a > 2 || totals.b > 2) throw new Error('FEN 士/相数量超出 2 个');
    return fen.trim();
  }

  /* ---------------- 加载 ---------------- */

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[data-godogpaw="${src}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.dataset.godogpaw = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`加载失败：${src}`));
      document.head.appendChild(s);
    });
  }

  function waitForApis(timeoutMs) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      pollTimer = setInterval(() => {
        const missing = REQUIRED.filter((n) => typeof window[n] !== 'function');
        if (missing.length === 0) {
          clearInterval(pollTimer); pollTimer = null;
          resolve();
          return;
        }
        if (Date.now() - t0 > timeoutMs) {
          clearInterval(pollTimer); pollTimer = null;
          reject(new Error(`引擎启动超时，缺少接口：${missing.join(', ')}`));
        }
      }, POLL_INTERVAL);
    });
  }

  /**
   * 加载并启动引擎。可重复调用（只真正加载一次）。
   * 失败时 reject，并把 state 置为 error（页面据此显示错误面板）。
   */
  function load() {
    if (loadPromise) return loadPromise;
    if (location.protocol === 'file:') {
      const e = new Error('当前是 file:// 协议。WebAssembly 与 fetch 会被浏览器拦，请用 HTTP 打开（python tools/serve.py 8000）');
      setState('error', e);
      loadPromise = Promise.reject(e);
      return loadPromise;
    }

    setState('loading');
    loadPromise = (async () => {
      try {
        if (typeof window.Go !== 'function') await loadScript(GLUE);
        if (typeof window.Go !== 'function') throw new Error('wasm_exec.js 加载后仍找不到 Go 构造器');

        const go = new window.Go();
        goRuntime = go;
        // 胶水默认按 <script> 的 URL 找 wasm；这里显式指定，避免依赖当前页路径
        const resp = await fetch(WASM);
        if (!resp.ok) throw new Error(`引擎文件 ${WASM} 取不到（HTTP ${resp.status}）`);
        const bytes = await resp.arrayBuffer();
        const result = await WebAssembly.instantiate(bytes, go.importObject);

        // go.run 是长跑 Promise（Go 里 select{} 不返回）。它 reject 就意味着 runtime 挂了。
        go.run(result.instance).catch((err) => {
          console.error('[godogpaw] Go runtime 退出:', err);
          setState('crashed', err);
          emit('crash', { at: 'runtime', error: err });
        });

        await waitForApis(LOAD_TIMEOUT);
        invoke('engineNewGame', ['']);   // 空串 = 标准开局，绝不用自定义 FEN 起局
        setState('ready');
        console.log('[godogpaw] 引擎就绪');
      } catch (e) {
        setState('error', e);
        loadPromise = null;              // 允许「重新检测」再试一次
        throw e;
      }
    })();
    return loadPromise;
  }

  /* ---------------- 对局接口 ---------------- */

  function assertUsable() {
    if (state === 'crashed') throw new Error('引擎已停止运行，请刷新页面');
    if (state !== 'ready') throw new Error('引擎还没就绪');
  }

  /** 起一局。不传参数就是标准开局；传 FEN 必须通过校验且在白名单里 */
  function newGame(fen) {
    assertUsable();
    const use = fen === undefined || fen === '' ? '' : validateFen(fen);
    if (use && !ALLOWED_FEN.has(use)) throw new Error('只支持标准开局（界面不提供自定义局面，规避引擎的 FEN 崩溃缺陷）');
    invoke('engineNewGame', [use]);
    searchDepth = 0;
    return getBoard();
  }

  /** 读盘面：{ board[90], sideToMove, inCheck, isGameOver, lastMoveFrom, lastMoveTo } */
  function getBoard() {
    assertUsable();
    const raw = invoke('engineGetBoard', []);
    let data;
    try { data = JSON.parse(raw); } catch (e) { throw new Error('引擎返回的盘面不是合法 JSON: ' + String(raw).slice(0, 80)); }
    if (!data || !Array.isArray(data.board) || data.board.length !== 90) throw new Error('引擎返回的盘面长度异常');
    return data;
  }

  /**
   * 某格的合法落点。
   * ⚠ 引擎只生成「轮到走子那一方」的着法：问非走子方的棋子，一律返回空数组。这是设计。
   */
  function movesFrom(square) {
    assertUsable();
    if (!Number.isInteger(square) || square < 0 || square > 89) return [];
    const raw = invoke('engineGetLegalMovesFrom', [square]);
    try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; } catch { return []; }
  }

  function move(from, to) {
    assertUsable();
    if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
    if (from < 0 || from > 89 || to < 0 || to > 89) return false;
    return invoke('engineDoMoveBySquares', [from, to]) === true;
  }

  function undo() {
    assertUsable();
    const r = invoke('engineUndoMove', []);
    if (window.GodogpawDebug) console.debug('[godogpaw] undo →', r, 'state=', state);
    return r === true;
  }

  function isThinking() { return searchDepth > 0; }

  /**
   * 让引擎思考并落子。
   * @param {number} depth 搜索深度（正整数；<=0 时引擎内部用默认 4）
   * @param {number} timeMs 每步思考上限（毫秒；<=0 = 不限时，只按深度）
   * @returns {Promise<string>} 引擎走出的着法，如 "b2e2"；引擎没着法时返回 ''
   * ⚠ 引擎自己会落子，调用方不要再补 doMove。
   */
  async function search(depth, timeMs) {
    assertUsable();
    if (searchDepth > 0) throw new Error('引擎正在思考上一步，请稍候');
    const d = Number.isFinite(depth) ? Math.max(0, Math.min(30, Math.floor(depth))) : 0;
    const t = Number.isFinite(timeMs) ? Math.max(0, Math.min(60000, Math.floor(timeMs))) : 0;
    searchDepth = d || 4;
    const started = Date.now();
    try {
      const result = await Promise.race([
        Promise.resolve(invoke('engineSearch', [d, t])),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`引擎思考超过 ${SEARCH_WATCHDOG / 1000}s 没有回应`)), SEARCH_WATCHDOG)),
      ]);
      return typeof result === 'string' ? result : '';
    } finally {
      searchDepth = 0;
      if (Date.now() - started > 15000) console.warn('[godogpaw] 本次思考耗时 ' + Math.round((Date.now() - started) / 1000) + 's');
    }
  }

  /* ---------------- 对外 ---------------- */

  window.Godogpaw = {
    // 元信息
    START_FEN,
    DIR,
    WASM,
    // 状态
    get state() { return state; },
    get error() { return lastError; },
    get ready() { return state === 'ready'; },
    get crashed() { return state === 'crashed'; },
    isThinking,
    on,
    load,
    // 对局
    newGame,
    getBoard,
    movesFrom,
    move,
    undo,
    search,
    // 棋子码值工具
    isRed,
    isBlack,
    validateFen,
  };
})();
