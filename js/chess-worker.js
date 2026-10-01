/* eslint-env worker */
/**
 * 国际象棋引擎 Worker —— Stockfish（UCI）
 *
 * 这是唯一的引擎后端，依赖 js/lib/stockfish.js。
 *
 * ⚠ 必须用**经典 Worker**（不能 { type: 'module' }）：
 * Stockfish 的 Emscripten 构建通过 importScripts / self.onmessage 工作，
 * 而 module worker 里没有 importScripts。
 *
 * 引擎构建：Niklas Fiekas 的 stockfish.js（js/lib/stockfish.js 1.5 MB
 * + js/lib/stockfish.wasm 546 KB），与 Knight-Chess-Helper 用的完全一致。
 *
 * 启动方式照抄参考项目 offscreen.js 的做法：
 *   new Worker(ENGINE_URL)          // 绝对 URL，不加任何 hash 后缀
 *
 * 为什么不用 '#<wasm名>,worker' 后缀：那是**另一套上游**（nmrugg/stockfish.js）
 * 的约定 —— 它靠 self.location.hash 拼 locateFile。当前这个构建的
 * locateFile 是 `function(file){ return file }`，wasm 路径由
 * `scriptDirectory = self.location.href`（即引擎脚本自身 URL）推导，
 * 所以 stockfish.wasm 只要和 stockfish.js 放在同一目录就会被自动找到。
 * 加 hash 反而可能让 scriptDirectory 的 lastIndexOf('/') 算错位置。
 *
 * 不需要任何 COOP/COEP 响应头：这是单线程构建，没用到 SharedArrayBuffer。
 */

/**
 * 引擎脚本地址必须是**绝对路径**。
 *
 * 本 worker 自己位于 `<root>/js/chess-worker.js`，而 Worker 里的相对 URL
 * 是相对于 worker 脚本自身解析的，不是相对于页面。所以写
 * `new Worker('js/lib/stockfish.js')` 会解析成 `<root>/js/js/lib/stockfish.js`
 * → 404，表现为「引擎静默无响应 / 不可用」。
 * 这里用 self.location 显式拼出站点根路径。
 */
const SITE_ROOT = new URL('../', self.location.href).href;
const ENGINE_URL = new URL('js/lib/stockfish.js', SITE_ROOT).href;

let sf = null;                 // 内层加载引擎的 worker
let mode = 'pending';          // pending | stockfish | failed
let uciReady = false;
let queue = [];                // 就绪前缓存的 UCI 命令
let currentGen = 0;
let seenBanner = false;
let seenInfo = false;
let currentSide = 'w';         // 当前局面的行棋方，用于把 UCI 分数换成白方视角

/**
 * UCI 的 score/mate 是「行棋方视角」，主线程统一按白方视角显示。
 * 这里做一次归一化。
 */
function toWhiteScore(value, side) {
  return side === 'w' ? value : -value;
}

/* ---------------- UCI 解析 ---------------- */

function parseInfo(line) {
  const info = {};
  const parts = line.split(/\s+/);
  for (let i = 1; i < parts.length; i++) {
    const key = parts[i];
    switch (key) {
      case 'depth': info.depth = +parts[++i]; break;
      case 'seldepth': info.seldepth = +parts[++i]; break;
      case 'nodes': info.nodes = +parts[++i]; break;
      case 'nps': info.nps = +parts[++i]; break;
      case 'time': info.time = +parts[++i]; break;
      case 'multipv': info.multipv = +parts[++i]; break;
      case 'score':
        if (parts[i + 1] === 'cp') { info.score = +parts[++i + 1]; i++; }
        else if (parts[i + 1] === 'mate') { info.mate = +parts[++i + 1]; i++; }
        break;
      case 'pv': info.pv = parts.slice(i + 1); i = parts.length; break;
      default: break;
    }
  }
  return info;
}

const DBG = true;
function dlog() {
  if (!DBG) return;
  console.log.apply(console, ['[sf]'].concat([].slice.call(arguments)));
}

function send(cmd) {
  if (!sf) { dlog('!! send 但 sf 为 null:', cmd); return; }
  dlog('>', cmd.length > 70 ? cmd.slice(0, 70) + '…' : cmd);
  sf.postMessage(cmd);
}

function flush() {
  while (queue.length && uciReady) send(queue.shift());
}

function handleLine(raw) {
  const line = String(raw).trim();
  if (!line) return;
  if (line === 'uciok' || line === 'readyok' || line.startsWith('bestmove')) dlog('<', line);
  else if (line.startsWith('info ')) { /* info 太吵，只记第一条 */ if (!seenInfo) { seenInfo = true; dlog('<', line.slice(0, 70)); } }
  else if (!seenBanner) { seenBanner = true; dlog('<', line.slice(0, 70)); }

  if (line === 'uciok') {
    // uciok 本身就代表引擎已初始化完毕 —— 不需要再等 isready/readyok。
    //
    // 为什么：实测在本项目里，若在 uciok 到达的同一刻立刻发 isready，
    // 引擎那会儿可能还停在自己的 postRun 阶段，isready 会被吞掉且
    // 永远不回 readyok。uciReady 于是卡在 false，队列里的 position/go
    // 永远滞留 —— 表现就是「引擎加载成功但 AI 从不走子」。
    // 参考项目（Knight-Chess-Helper）也没等 readyok。
    uciReady = true;
    send('setoption name Threads value 1');   // 单线程构建，显式写死 1
    send('setoption name Hash value 16');
    flush();
    self.postMessage({ type: 'ready' });
    return;
  }
  if (line === 'readyok') {
    // 只为兼容而存在：即使引擎主动回了 readyok，也不再触发 flush
    //（flush 已在 uciok 时做过了），避免重复下发命令。
    return;
  }
  if (line.startsWith('info ')) {
    const info = parseInfo(line);
    if (info.score !== undefined) info.score = toWhiteScore(info.score, currentSide);
    if (info.mate !== undefined) info.mate = toWhiteScore(info.mate, currentSide);
    self.postMessage({ type: 'info', data: { ...info, gen: currentGen } });
    return;
  }
  if (line.startsWith('bestmove')) {
    const move = line.split(/\s+/)[1] || '';
    self.postMessage({
      type: 'bestmove',
      data: { move: move === '(none)' ? '' : move, gen: currentGen },
    });
  }
  // id / uci / copyry 等握手噪声忽略
}

function fail(reason) {
  mode = 'failed';
  if (sf) {
    try { sf.terminate(); } catch (e) { /* 已退出 */ }
    sf = null;
  }
  self.postMessage({ type: 'unavailable', data: { reason } });
}

function boot() {
  let inner;
  try {
    // 照抄参考项目：绝对 URL，不加 hash 后缀。
    // wasm 由引擎从脚本同目录自动加载（scriptDirectory = self.location.href）。
    dlog('创建引擎 worker:', ENGINE_URL);
    inner = new Worker(ENGINE_URL);
  } catch (e) {
    dlog('!! 创建失败:', e.message);
    fail('无法创建引擎线程：' + (e.message || e));
    return;
  }

  let booted = false;

  // wasm 有 546 KB，首次实例化要时间。给足 30s 再判失败。
  const timer = setTimeout(() => {
    if (booted) return;
    fail('引擎加载超时（30s，请确认 js/lib/stockfish.wasm 存在且服务器返回 application/wasm）');
  }, 30000);

  inner.onmessage = (e) => {
    const line = String(e.data);
    if (!booted && line.includes('uciok')) {
      booted = true;
      clearTimeout(timer);
      dlog('握手完成（booted=true）');
    }
    handleLine(line);
  };
  inner.onerror = (e) => {
    dlog('!! inner.onerror:', e.message, 'line', e.lineno);
    clearTimeout(timer);
    if (!booted) fail(e.message || '引擎脚本执行失败');
  };

  sf = inner;
  mode = 'stockfish';
  // 只发 uci。参考项目也是这么做的。
  // **不要**在这里补一条 isready：UCI 规定 isready 必须在 uciok 之后，
  // 提前发会让引擎先回一个 readyok，把 uciok/readyok 的配对顺序打乱，
  // 握手状态机（uciReady + queue）就再也对不上了。
  send('uci');
}

/* ---------------- 对外协议 ---------------- */

self.onmessage = function (e) {
  const { type, data } = e.data || {};
  dlog('收到主线程消息:', type);

  switch (type) {
    case 'boot':
      boot();
      break;

    case 'init':
    case 'setfen':
      currentGen = data.gen !== undefined ? data.gen : currentGen;
      dlog('  init: currentGen=' + currentGen + ' uciReady=' + uciReady + ' queue=' + queue.length);
      // FEN 的第 2 段是行棋方：' w ... ' 或 ' b ... '
      if (typeof data.fen === 'string') currentSide = data.fen.split(' ')[1] === 'b' ? 'b' : 'w';
      if (mode === 'stockfish') {
        // 全部走 queue：uciok 之前任何命令都不能直接发给引擎。
        // 尤其是 isready —— UCI 规定它必须在 uciok 之后，提前发会让
        // 引擎回一个 readyok 打乱握手配对，主线程于是永远等不到 ready。
        queue.push('ucinewgame');
        queue.push('position fen ' + data.fen);
        flush();
      }
      break;

    case 'go': {
      seenInfo = false;
      dlog('  go: data.gen=' + data.gen + ' currentGen=' + currentGen
        + ' mode=' + mode + ' uciReady=' + uciReady);
      if (data.gen !== currentGen) { dlog('  !! 丢弃：gen 不匹配'); break; }
      if (mode !== 'stockfish') { dlog('  !! 丢弃：mode=' + mode); break; }
      // 每次都从完整 FEN 重建局面，避免增量同步出错
      if (typeof data.fen === 'string') currentSide = data.fen.split(' ')[1] === 'b' ? 'b' : 'w';
      queue.push('position fen ' + data.fen);
      // depth 优先！movetime 是「上限」不是「目标」—— Stockfish 会把时间
      // 用满才停。实测本引擎深度 8 只要 0.3 秒，而 movetime 8000 会让
      // 每一步都硬等 8 秒。两者同时给时 movetime 会盖掉 depth，所以
      // 这里必须让 depth 胜出，movetime 仅在没给 depth 时才作为兜底。
      if (data.infinite) {
        queue.push('go infinite');
      } else if (data.depth) {
        queue.push('go depth ' + data.depth);
      } else if (data.movetime) {
        queue.push('go movetime ' + data.movetime);
      } else {
        queue.push('go depth 4');
      }
      if (!uciReady) dlog('  !! uciReady=false，命令滞留队列（握手未完成？）');
      flush();
      break;
    }

    case 'stop':
      if (mode === 'stockfish' && uciReady) send('stop');
      else dlog('  stop 被忽略（mode=' + mode + ' uciReady=' + uciReady + '）');
      break;

    case 'quit':
      if (sf) {
        send('quit');
        try { sf.terminate(); } catch (err) { /* 已退出 */ }
        sf = null;
      }
      self.close();
      break;

    default:
      break;
  }
};
