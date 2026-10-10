/* eslint-env worker */
/**
 * 中国象棋引擎 Worker —— 象眼 ElephantEye（UCCI 协议）
 *
 * ======================= 选型记录（都是实测，不是推测） =======================
 *
 * 【为什么不是 Pikafish】
 * 官方 Pikafish 没有浏览器 WASM 构建；能找到的第三方单线程构建实测**搜索不可用**：
 *   · `uci` / `d` / `isready` 都正常，局面也能正确显示
 *   · 但任何 `go`（depth / movetime / infinite）一律回
 *         info depth 0 score mate 0
 *         bestmove (none)
 *   · 连引擎自带的 `bench`（48 个标准局面，含开局）也是同样结果
 *     症状 = 引擎认为开局已是终局。Node 与真实浏览器（Edge）实测一致，
 *     所以不是模拟环境的问题，是这个构建本身坏了。
 *   另一个全强度构建 wasm 仅 662 KB，但需另下 48 MB 的 NNUE 权重，超出体积要求。
 *
 * 【为什么是象眼】
 * ElephantEye（C++ → WASM，纯评估、无 NNUE）实测：
 *   · 体积 174 KB（eleeye.js 67 KB + eleeye.wasm 107 KB）
 *   · **只认 `go depth`**：`go movetime` / `go time` / `go nodes` / `go infinite`
 *     全部不返回（实测阻塞）。所以难度只能用深度表达，不能用思考时间
 *   · 实测搜索耗时（Node，同一局面）：depth 4 ≈ 13ms · 6 ≈ 56ms
 *     · 8 ≈ 771ms · 10 ≈ 5.3s —— 刚好映射三档难度
 *   · 单线程，不需要 COOP/COEP 响应头
 *
 * 【输出回调】
 * 这个构建用 `print`（不是 Pikafish 那个构建的 `onReceiveStdout`）。
 * 传错回调名的症状是「模块就绪、命令送到了、但一条输出都没有」——
 * 排查时先确认命令有没有送达，再怀疑参数（见 HANDOFF-CONTEXT 第二节）。
 *
 * 【同步语义】
 * `execute_ucci_command` 是**同步阻塞**的：发出 `go` 后这行代码不会返回，
 * 直到搜索结束、bestmove 打印完。所以「等引擎」= 等 ccall 返回，
 * 不需要额外轮询；搜索也因此被隔离在 Worker 线程里，不卡界面。
 *
 * ⚠ 引擎文件（js/lib/eleeye/，两个必须同目录）：
 *   eleeye.js   67 KB   Emscripten 胶水
 *   eleeye.wasm 107 KB  引擎本体
 *
 * ⚠ UCCI 的着法用 ICCS 记法（如 h2e2），不是国际象棋那种 e2e4。
 */

/**
 * 引擎脚本地址必须是**绝对路径**。
 *
 * 本 worker 位于 `<root>/js/xiangqi-worker.js`，而 Worker 里的相对 URL
 * 是相对于 worker 脚本自身解析的，不是相对于页面。写
 * `new Worker('js/lib/eleeye/eleeye.js')` 会解析成
 * `<root>/js/js/lib/eleeye/eleeye.js` → 404。
 */

(function () {
  'use strict';

const SITE_ROOT = new URL('../', self.location.href).href;
const ENGINE_JS = new URL('js/lib/eleeye/eleeye.js', SITE_ROOT).href;

let wasm = null;               // Emscripten 模块
let execute = null;            // cwrap 出来的命令下发函数
let createFactory = null;      // 胶水导出的工厂函数（importScripts 后才拿到）
let ready = false;
let currentGen = 0;
let bootFailed = false;

const DBG = true;
function dlog() {
  if (!DBG) return;
  console.log.apply(console, ['[ele]'].concat([].slice.call(arguments)));
}

/* ---------------- UCCI 输出解析 ---------------- */

/**
 * 解析 UCCI 的 info 行。
 *
 * 与 UCI 的差别：分数是**整数值**（不是厘兵），且没有 mate 概念。
 * 例：info depth 8 score 4 time 771 nodes 140456 pv c3c4 b9c7 ...
 */
function parseInfo(line) {
  const info = {};
  const parts = line.split(/\s+/);
  for (let i = 1; i < parts.length; i++) {
    const key = parts[i];
    switch (key) {
      case 'depth': info.depth = +parts[++i]; break;
      case 'nodes': info.nodes = +parts[++i]; break;
      case 'time': info.time = +parts[++i]; break;
      case 'nps': info.nps = +parts[++i]; break;
      case 'score': info.score = +parts[++i]; break;
      case 'pv': info.pv = parts.slice(i + 1); i = parts.length; break;
      default: break;
    }
  }
  return info;
}

function handleLine(raw) {
  const line = String(raw).trim();
  if (!line) return;
  if (line.startsWith('bestmove')) dlog('<', line);
  else dlog('<', line.slice(0, 70));

  if (line.startsWith('info ')) {
    const info = parseInfo(line);
    if (info.depth !== undefined) {
      self.postMessage({ type: 'info', data: { ...info, gen: currentGen } });
    }
    return;
  }
  if (line.startsWith('bestmove')) {
    const move = line.split(/\s+/)[1] || '';
    self.postMessage({
      type: 'bestmove',
      data: { move: (move === '(none)' || move === '0000') ? '' : move, gen: currentGen },
    });
  }
  // id / option 等握手噪声忽略
}

function fail(reason) {
  bootFailed = true;
  ready = false;
  self.postMessage({ type: 'unavailable', data: { reason } });
}

function boot() {
  dlog('加载引擎胶水:', ENGINE_JS);
  try {
    // ⚠ 经典 Worker（不能 { type: 'module' }）：引擎靠 importScripts 工作
    importScripts(ENGINE_JS);
    // 胶水末尾只挂了 CommonJS / AMD 分支，Worker 里两者都没有，
    // 所以它靠顶层 `var createEleeyeModule` 落到全局上。
    // 显式从 globalThis 取一次，比裸标识符稳（也便于给出可读的错误）。
    const factory = (typeof createEleeyeModule !== 'undefined')
      ? createEleeyeModule
      : (self.createEleeyeModule || globalThis.createEleeyeModule);
    if (typeof factory !== 'function') {
      fail('引擎胶水已加载但未找到 createEleeyeModule'
        + '（self.createEleeyeModule=' + typeof self.createEleeyeModule + '）');
      return;
    }
    createFactory = factory;
  } catch (e) {
    dlog('!! importScripts 失败:', e && e.message);
    fail('引擎脚本加载失败：' + ((e && e.message) || e));
    return;
  }

  const base = ENGINE_JS.substring(0, ENGINE_JS.lastIndexOf('/') + 1);
  let settled = false;
  // wasm 首次实例化很快（实测 13ms），30s 只是宽裕上限
  const timer = setTimeout(() => {
    if (settled) return;
    fail('引擎加载超时（30s，请确认 js/lib/eleeye/ 下两个文件齐全，'
      + '且服务器能返回 application/wasm）');
  }, 30000);

  try {
    const p = createFactory({
      locateFile: (path) => base + path,
      // ⚠ 这个构建的输出走 print（实测）。传 onReceiveStdout 会一条输出都没有。
      print: (s) => handleLine(s),
      printErr: (s) => dlog('!! stderr:', s),
      noInitialRun: true,
    });
    p.then((mod) => {
      settled = true;
      clearTimeout(timer);
      wasm = mod;
      if (typeof mod.ccall !== 'function') {
        fail('引擎模块缺少 ccall');
        return;
      }
      try {
        mod.ccall('init_eleeye_engine', null, [], []);
      } catch (e) {
        fail('引擎初始化失败：' + ((e && e.message) || e));
        return;
      }
      execute = (cmd) => mod.ccall('execute_ucci_command', null, ['string'], [cmd]);
      ready = true;
      dlog('引擎就绪（ElephantEye）');
      self.postMessage({ type: 'ready' });
    }).catch((e) => {
      settled = true;
      clearTimeout(timer);
      fail('引擎实例化失败：' + ((e && e.message) || e));
    });
  } catch (e) {
    settled = true;
    clearTimeout(timer);
    fail('无法创建引擎实例：' + ((e && e.message) || e));
  }
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
      // 象眼不需要预先设局面（每次 go 前都会带 position fen），这里只记代数
      currentGen = data.gen !== undefined ? data.gen : currentGen;
      break;

    case 'go': {
      dlog('  go: gen=' + data.gen + ' currentGen=' + currentGen
        + ' ready=' + ready + ' depth=' + data.depth);
      if (data.gen !== currentGen) { dlog('  !! 丢弃：gen 不匹配'); break; }
      if (!ready || !execute) { dlog('  !! 丢弃：引擎不可用'); break; }
      // ⚠ 只能用 depth：实测 go movetime / go time / go nodes / go infinite
      //   都不会返回（阻塞），只有 go depth 能正常交出 bestmove。
      const depth = data.depth || 6;
      try {
        execute('position fen ' + data.fen);
        // 同步阻塞到这一行返回为止，bestmove 已在 execute 内部打印并转发
        execute('go depth ' + depth);
      } catch (err) {
        dlog('!! 搜索抛错:', err && err.message);
        self.postMessage({
          type: 'error',
          data: { gen: currentGen, message: (err && err.message) || err },
        });
      }
      break;
    }

    case 'quit':
      ready = false;
      execute = null;
      wasm = null;
      self.close();
      break;

    default:
      break;
  }
};
}());
