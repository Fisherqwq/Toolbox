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
 * 引擎构建：nmrugg/stockfish.js **v19.0.0 lite-single**
 * （js/lib/stockfish.js 21 KB + js/lib/stockfish.wasm 1.7 MB，NNUE 权重已内嵌）。
 *
 * ⚠ 启动时**不要**加 '#stockfish.wasm,worker' 后缀（见 boot() 里的注释）。
 * 引擎源码里有 `self.location.hash.split(',')[1] === 'worker'` 这段判断，
 * 命中它会走进一条早期特殊分支，实测在浏览器里彻底卡死、零输出。
 * 不带 hash 反而正常：引擎会用 `typeof importScripts === 'function'`
 * 识别出 Worker 环境。
 *
 * ⚠ 就绪判据是 `uciok` 而不是 `readyok`，且启动时有界重发 uci ——
 * 两者都是实测踩出来的，详见 handleLine() 与 boot() 里的注释。
 *
 * 不需要任何 COOP/COEP 响应头：这是单线程 lite 构建，没用到 SharedArrayBuffer。
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
 * ready 信号的去重与兜底。
 * 为什么需要：ready 只发一次，如果它在极端时序下没被主线程收到，
 * 主线程会永远停在「正在加载 Stockfish…」（实测踩过）。
 * 现在主线程会补发 isready 探活，引擎回 readyok 时这里可以再补一次。
 */
let readyPosted = false;       // 已经发出过 ready
let readyAcked = false;        // 已经收到过 uciok（可以接受 isready 探活）

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
    // 注意：这里**不要**发 setoption。
    //
    // 实测（浏览器控制台三段对照测试）：一旦在 go 之前发过
    // `setoption name Threads value 1` / `setoption name Hash value 16`，
    // 引擎就会彻底沉默 —— 连一条 info 都不吐。原因是 Stockfish 处理
    // Threads 选项会重建线程池，而本构建是**单线程 wasm**（Threads max 1），
    // 重建线程池在无 pthread 的环境下会把引擎打挂。
    //
    // 而且这两条本来就没必要：引擎默认值已经是 Threads=1、Hash=16，
    // 发出去等于「用一个会触发重建的路径去设置成它已有的值」。
    flush();
    // ⚠ 这里整段都必须容错：一旦抛错，「engineReady 永远为 false」，
    //   主线程只会一直显示「正在加载 Stockfish…」，而且看不到任何报错。
    //   实测症状：worker 日志里 `< uciok`、`握手完成` 都在，主线程却像没收到一样。
    try {
      self.postMessage({ type: 'ready' });
      readyPosted = true;
    } catch (e) {
      dlog('!! postMessage(ready) 失败:', e && e.message);
    }
    // 兜底：主线程若仍没收到 ready（消息在极端时序下丢失），
    // 会在 1.5s 后发 isready；引擎回 readyok 时再补发一次。
    readyAcked = true;
    return;
  }
  if (line === 'readyok') {
    // 只为兼容而存在：flush 已在 uciok 时做过了，这里不再触发。
    // 但若主线程是用 isready 在兜底探活，就借这个 readyok 把 ready 补上。
    if (readyAcked && !readyPosted) {
      readyPosted = true;
      try { self.postMessage({ type: 'ready' }); } catch (e) { dlog('!! 补发 ready 失败:', e && e.message); }
    }
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
    // ⚠ **不要**加 '#<wasm名>,worker' 后缀。
    // 引擎里确实有这段判断：
    //   self.location.hash.split(',')[1] === 'worker'
    // 但命中它会走进一条**早期特殊分支**，实测那条路在浏览器里会彻底卡死
    // （worker 脚本加载成功、无 onerror、但一个字节都不输出，uciok 永不回来）。
    // 不带 hash 时该判断落空，引擎转而用
    //   typeof importScripts === 'function'
    // 正常识别 Worker 环境，反而一切正常。实测 A/B 验证过。
    dlog('创建引擎 worker:', ENGINE_URL);
    inner = new Worker(ENGINE_URL);
  } catch (e) {
    dlog('!! 创建失败:', e.message);
    fail('无法创建引擎线程：' + (e.message || e));
    return;
  }

  let booted = false;

  // wasm 有 1.7 MB（NNUE 权重已内嵌），首次实例化要时间。给足 30s。
  const timer = setTimeout(() => {
    if (booted) return;
    clearInterval(retry);
    fail('引擎加载超时（30s，请确认 js/lib/stockfish.wasm 存在且服务器返回 application/wasm）');
  }, 30000);

  // 这个构建的启动函数跑在 onmessage 赋值**之前**，极端时序下立刻发出的
  // uci 会在接线完成前到达并被丢弃，于是永远等不到 uciok。
  // 所以这里有界重发 uci，拿到 uciok 立刻停。
  let uciTries = 0;
  const retry = setInterval(() => {
    if (booted) { clearInterval(retry); return; }
    if (++uciTries > 8) { clearInterval(retry); fail('引擎未响应 uci'); return; }
    dlog('重发 uci（第 ' + uciTries + ' 次）');
    send('uci');
  }, 900);

  inner.onmessage = (e) => {
    const line = String(e.data);
    if (!booted && line.includes('uciok')) {
      booted = true;
      clearTimeout(timer);
      clearInterval(retry);
      dlog('握手完成（booted=true）');
    }
    // ⚠ 必须包起来：handleLine 抛错会让 worker 静默半死 ——
    //   ready 发不出去，主线程就一直显示「正在加载」，且没有报错可查。
    try {
      handleLine(line);
    } catch (err) {
      dlog('!! handleLine 抛错:', line.slice(0, 60), err && err.message);
    }
  };
  inner.onerror = (e) => {
    dlog('!! inner.onerror:', e.message, 'line', e.lineno);
    clearTimeout(timer);
    clearInterval(retry);
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

    /**
     * 探活：主线程在「worker 侧已过 uciok，但 1.5s 内没收到 ready」时发这条。
     * 两种回法，主线程都认：
     *   · 已经 ready 过 → 直接重发 ready（幂等，主线程按状态收敛）
     *   · 还没 ready    → 发一条 isready，引擎回 readyok 时补发 ready
     */
    case 'ping':
      dlog('  ping: uciReady=' + uciReady + ' readyPosted=' + readyPosted);
      if (readyPosted) {
        try { self.postMessage({ type: 'ready' }); } catch (err) { dlog('!! 重发 ready 失败:', err && err.message); }
      } else if (uciReady) {
        send('isready');
      }
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
