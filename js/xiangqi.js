/**
 * 中国象棋 · 页面逻辑（重做版）
 *
 * 引擎：godogpaw（Go/WASM），走 js/lib/godogpaw/godogpaw-bridge.js
 * 规则、走法生成、将军/将死判定全部由引擎提供 —— 本文件**不实现任何象棋规则**。
 *
 * 与外层保持一致的三条约定（照 js/chess.js、js/gomoku.js 的写法）：
 *   1. `window.XiangqiApp = { init }`，由 js/main.js 在切到 #/xiangqi 时调用；init 幂等。
 *   2. 棋盘用 canvas 画，渲染与命中检测**共用**同一套坐标变换（踩过坑：分开写必然错位）。
 *   3. 难度走出第一步后锁定，只有「新对局」解锁。
 *
 * ⚠ 坐标（bridge 注释里有完整说明）：sq = file + rank*9，rank 0 = 红方底线。
 *   红方在下时：画布 y 从 rank 9（顶部）递增到 rank 0（底部）→ py = MARGIN + (9-rank)*CELL。
 *
 * ⚠ 引擎已知缺陷（不在此处修规则，只做隔离/记录）：
 *   · engineSearch 可能走出「自己送将」的着法（自爆）→ 只记录复现步骤
 *   · engineNewGame 收到畸形 FEN 会 panic 打死 runtime → bridge 层用白名单挡住
 *
 * ⚠ 排查手法：`window.XiangqiDebug = true` 会把每个关键分支打进控制台，
 *   同时每一步都留在 `window.__xqLog` 里供自动化测试读取。
 *   （本文件开发期踩过的两个坑都是靠它定位的：SW 首装重载打断首次点击；
 *     `let` 暂时性死区让 AI 那一路静默抛错。）
 */
(function () {
  'use strict';

  /* ============================================================
   * 常量
   * ============================================================ */
  const FILES = 9;          // 纵线（file）
  const RANKS = 10;         // 横线（rank）
  const LOGICAL_W = 640;    // canvas 逻辑宽度
  const MARGIN = 44;        // 边距：给坐标与棋子留余量
  const CELL = (LOGICAL_W - MARGIN * 2) / (FILES - 1);   // 69
  const LOGICAL_H = Math.round(MARGIN * 2 + (RANKS - 1) * CELL); // 709

  const RED = 0;            // 引擎的 sideToMove：0 = 红
  const BLACK = 1;

  // 棋子码值 → 汉字。红黑用不同字形（俥/车、傌/马、炮/砲），与象棋谱一致
  const GLYPH = {
    1: '俥', 2: '仕', 3: '炮', 4: '兵', 5: '傌', 6: '相', 7: '帅',
    9: '车', 10: '士', 11: '砲', 12: '卒', 13: '马', 14: '象', 15: '将',
  };
  // 记谱用的单字（红黑统一用简体常用字）
  const NOTE_CHAR = {
    1: '车', 2: '仕', 3: '炮', 4: '兵', 5: '马', 6: '相', 7: '帅',
    9: '车', 10: '士', 11: '炮', 12: '卒', 13: '马', 14: '象', 15: '将',
  };
  const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

  const SCORE_KEY = 'xiangqi-scores-v1';

  // 难度：深度与时间两个维度，引擎的 engineSearch(depth, ms) 两者都支持（实测）
  // 实测耗时（Node，开局）：depth2 = 8ms · depth4 = 64ms · depth6 = 451ms · depth8 = 1548ms
  // 搜索跑在主线程会阻塞界面，所以「困难」给 1200ms 时间上限兜底。
  const PRESETS = {
    easy: { depth: 2, timeMs: 0, hint: '搜索 2 层 · 秒回' },
    normal: { depth: 4, timeMs: 0, hint: '搜索 4 层 · 约 0.1 秒' },
    hard: { depth: 8, timeMs: 1200, hint: '搜索 8 层（1.2 秒上限）' },
  };
  const CUSTOM_LIMITS = {
    depth: { min: 1, max: 20 },
    time: { min: 100, max: 30000 },
  };

  const $ = (id) => document.getElementById(id);

  /* ============================================================
   * 调试埋点
   * ============================================================ */
  const dbgLog = [];
  function dbg(tag, data) {
    if (typeof window !== 'undefined' && window.XiangqiDebug) {
      console.log('[xq]', tag, data === undefined ? '' : data);
    }
    dbgLog.push({ t: Date.now(), tag, data });
    if (dbgLog.length > 500) dbgLog.shift();
  }
  if (typeof window !== 'undefined') window.__xqLog = dbgLog;

  /* ============================================================
   * 状态
   * ============================================================ */
  let canvas, ctx;
  let dpr = 1;
  let initialized = false;
  let engineBound = false;

  let boardData = new Array(90).fill(0);
  let sideToMove = RED;
  let inCheck = false;
  let gameOver = false;
  let lastMove = null;         // { from, to }
  let selected = -1;
  let legalTargets = [];
  let thinking = false;
  let flipped = false;         // false = 红方在下
  let gameStarted = false;     // 走出第一步后锁难度
  let moveCount = 0;

  let preset = 'normal';
  let customMode = 'depth';    // 'depth' | 'time'
  let custom = { depth: 6, timeMs: 3000 };
  /**
   * 玩家上次落子**之前**的盘面快照（90 格数组的字符串）。
   * 悔棋靠它判断"撤到位了没有"，而不是靠数手数：
   * 数手数会受时序影响（AI 那手是否已经记进 history 取决于读到哪一帧），
   * 实测偶发"只撤一手、记录剩半回合"。比对盘面则可自我纠正，撤到为止。
   */
  let boardBeforeLastHuman = null;

  let history = [];            // [{ from, to, cn, by }] 顺序即步序
  let scores = { red: 0, black: 0, draw: 0 };
  let resultShown = false;
  /**
   * 搜索代次：每次「新对局 / 悔棋 / 认输」都 ++，用来作废正在进行的 AI 搜索。
   * ⚠ 必须声明在 playMove / aiMove 之前 —— 曾经写在后面，aiMove() 第一句
   *   `++searchGen` 撞上 `let` 的暂时性死区抛 ReferenceError，AI 永远不应手。
   */
  let searchGen = 0;

  /* ============================================================
   * 坐标变换（渲染与命中检测共用）
   * ============================================================ */
  function cellCenter(sq) {
    const file = sq % 9;
    const rank = Math.floor(sq / 9);
    if (flipped) {
      // 黑方在下：rank 0 画在顶部
      return { px: MARGIN + (FILES - 1 - file) * CELL, py: MARGIN + rank * CELL };
    }
    // 红方在下：rank 0 画在底部
    return { px: MARGIN + file * CELL, py: MARGIN + (RANKS - 1 - rank) * CELL };
  }

  /** 画布像素 → sq；离任何交叉点太远返回 -1 */
  function squareAt(px, py) {
    const file = Math.round((px - MARGIN) / CELL);
    const vRank = Math.round((py - MARGIN) / CELL);       // 视觉行：0 = 顶部
    if (file < 0 || file >= FILES || vRank < 0 || vRank >= RANKS) return -1;
    if (Math.abs(px - (MARGIN + file * CELL)) > CELL / 2) return -1;
    if (Math.abs(py - (MARGIN + vRank * CELL)) > CELL / 2) return -1;
    const rank = flipped ? vRank : (RANKS - 1 - vRank);
    const sq = rank * 9 + file;
    return (sq >= 0 && sq < 90) ? sq : -1;
  }

  const squareName = (sq) => `${'abcdefghi'[sq % 9]}${Math.floor(sq / 9)}`;

  /* ============================================================
   * 画布
   * ============================================================ */
  function setupCanvas() {
    canvas = $('xqCanvas');
    if (!canvas) return false;
    ctx = canvas.getContext('2d');
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(LOGICAL_W * dpr);
    canvas.height = Math.round(LOGICAL_H * dpr);
    canvas.style.aspectRatio = `${LOGICAL_W} / ${LOGICAL_H}`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  function drawBoardBase() {
    // 木纹底：两层近似棋盘纹的浅色带，避免大面积纯色
    ctx.fillStyle = '#f0d8a8';
    ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
    ctx.fillStyle = 'rgba(196, 154, 92, .28)';
    ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H * 0.34);
    ctx.fillStyle = 'rgba(196, 154, 92, .16)';
    ctx.fillRect(0, LOGICAL_H * 0.66, LOGICAL_W, LOGICAL_H * 0.34);

    // 棋盘外框（比格线粗一档）
    ctx.strokeStyle = '#6b4b25';
    ctx.lineWidth = 2.2;
    ctx.strokeRect(MARGIN, MARGIN, (FILES - 1) * CELL, (RANKS - 1) * CELL);

    ctx.strokeStyle = 'rgba(107, 75, 37, .75)';
    ctx.lineWidth = 1;

    // 横线：10 条贯通
    for (let r = 0; r < RANKS; r++) {
      const y = MARGIN + r * CELL;
      ctx.beginPath();
      ctx.moveTo(MARGIN, y);
      ctx.lineTo(MARGIN + (FILES - 1) * CELL, y);
      ctx.stroke();
    }
    // 纵线：最左最右贯通，其余在楚河汉界处断开
    const riverTop = MARGIN + 4 * CELL;
    const riverBottom = MARGIN + 5 * CELL;
    for (let f = 0; f < FILES; f++) {
      const x = MARGIN + f * CELL;
      ctx.beginPath();
      if (f === 0 || f === FILES - 1) {
        ctx.moveTo(x, MARGIN);
        ctx.lineTo(x, MARGIN + (RANKS - 1) * CELL);
      } else {
        ctx.moveTo(x, MARGIN);
        ctx.lineTo(x, riverTop);
        ctx.moveTo(x, riverBottom);
        ctx.lineTo(x, MARGIN + (RANKS - 1) * CELL);
      }
      ctx.stroke();
    }

    // 九宫斜线（上下各一个）
    drawPalace(MARGIN, MARGIN);
    drawPalace(MARGIN, MARGIN + 7 * CELL);

    // 楚河汉界
    ctx.save();
    ctx.fillStyle = 'rgba(107, 75, 37, .82)';
    ctx.font = `600 ${Math.round(CELL * 0.4)}px 'Noto Serif SC', 'Songti SC', serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const riverY = MARGIN + 4.5 * CELL;
    ctx.fillText('楚 河', MARGIN + 2 * CELL, riverY);
    ctx.fillText('汉 界', MARGIN + 6 * CELL, riverY);
    ctx.restore();

    // 炮位与兵位的定位小角标（象棋盘的经典记号）
    ctx.strokeStyle = 'rgba(107, 75, 37, .7)';
    ctx.lineWidth = 1.2;
    const spots = [];
    for (const f of [0, 2, 4, 6, 8]) { spots.push(f + 3 * 9); spots.push(f + 6 * 9); }
    spots.push(1 + 2 * 9, 7 + 2 * 9, 1 + 7 * 9, 7 + 7 * 9);
    for (const sq of spots) drawPositionMarks(sq);
  }

  function drawPalace(x0, y0) {
    const size = 2 * CELL;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + size, y0 + size);
    ctx.moveTo(x0 + size, y0);
    ctx.lineTo(x0, y0 + size);
    ctx.stroke();
  }

  /** 交叉点四角的小括号 */
  function drawPositionMarks(sq) {
    const file = sq % 9;
    const { px, py } = cellCenter(sq);
    const gap = CELL * 0.14;
    const len = CELL * 0.2;
    const dirs = [];
    if (file > 0) dirs.push([-1, -1], [-1, 1]);
    if (file < FILES - 1) dirs.push([1, -1], [1, 1]);
    for (const [sx, sy] of dirs) {
      ctx.beginPath();
      ctx.moveTo(px + sx * gap, py + sy * gap);
      ctx.lineTo(px + sx * gap + sx * len, py + sy * gap);
      ctx.moveTo(px + sx * gap, py + sy * gap);
      ctx.lineTo(px + sx * gap, py + sy * gap + sy * len);
      ctx.stroke();
    }
  }

  function drawPiece(sq, code) {
    const { px, py } = cellCenter(sq);
    const radius = CELL * 0.44;
    // ⚠ 颜色必须按码值区间判断：红 1..7 / 黑 9..15。
    //   曾经写成 `code >= 1`，结果黑方（9..15）也判成红，整盘棋全是红的。
    const red = code <= 7;
    const ink = red ? '#b3261e' : '#26241f';

    // 阴影
    ctx.beginPath();
    ctx.arc(px + 1.5, py + 2.5, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(80, 50, 20, .22)';
    ctx.fill();

    // 棋子本体：米白圆 + 外圈
    const grad = ctx.createRadialGradient(px - radius * 0.35, py - radius * 0.4, radius * 0.2, px, py, radius);
    grad.addColorStop(0, '#fffaf0');
    grad.addColorStop(1, '#e8d5ae');
    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = ink;
    ctx.stroke();

    // 内圈
    ctx.beginPath();
    ctx.arc(px, py, radius - 4, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = red ? 'rgba(179, 38, 30, .55)' : 'rgba(38, 36, 31, .5)';
    ctx.stroke();

    // 汉字：字号取半径的 0.92 倍 —— 再大就会被圆边裁到（实测 1.05 倍时"俥"顶到边）
    ctx.save();
    ctx.fillStyle = ink;
    ctx.font = `700 ${Math.round(radius * 0.92)}px 'Noto Serif SC', 'Songti SC', 'KaiTi', serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(GLYPH[code] || '?', px, py + 1);
    ctx.restore();
  }

  function drawHighlight(sq, color, radius) {
    const { px, py } = cellCenter(sq);
    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  function render() {
    if (!ctx) return;
    drawBoardBase();

    // 上一步：两端各一个半透明圆
    if (lastMove) {
      for (const sq of [lastMove.from, lastMove.to]) {
        drawHighlight(sq, 'rgba(217, 135, 63, .38)', CELL * 0.46);
      }
    }
    // 选中
    if (selected >= 0) drawHighlight(selected, 'rgba(47, 127, 191, .3)', CELL * 0.46);
    // 合法落点：空格画点，可吃子画环
    for (const t of legalTargets) {
      const { px, py } = cellCenter(t);
      ctx.beginPath();
      if (boardData[t] !== 0) {
        ctx.arc(px, py, CELL * 0.44, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(47, 127, 191, .8)';
        ctx.stroke();
      } else {
        ctx.arc(px, py, CELL * 0.13, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(47, 127, 191, .62)';
        ctx.fill();
      }
    }
    // 棋子
    for (let sq = 0; sq < 90; sq++) {
      if (boardData[sq]) drawPiece(sq, boardData[sq]);
    }
  }

  /* ============================================================
   * 中文记谱
   *
   * 只做「起点 + 终点 + 棋盘」能推出的部分，规则与象棋谱一致：
   *   纵线号：红方从右往左数一~九（file 0 是九），黑方从左往右数 1~9
   *   进/退：对红方 rank 变大 = 进；对黑方相反
   *   平：同一横线
   * 兵/卒多子同线会写「前/后」，这里不做（需要统计同线子力，引擎不暴露，
   * 强行推断容易写错谱，宁可不写）。
   * ============================================================ */
  function cnFileNumber(file, side) {
    return side === RED ? CN_NUM[8 - file] : String(file + 1);
  }

  function chineseNotation(from, to) {
    const piece = boardData[from];
    if (!piece) return '';
    const side = piece <= 7 ? RED : BLACK;
    const fFrom = from % 9, rFrom = Math.floor(from / 9);
    const fTo = to % 9, rTo = Math.floor(to / 9);
    const head = (NOTE_CHAR[piece] || '?') + cnFileNumber(fFrom, side);
    if (rFrom === rTo) return `${head}平${cnFileNumber(fTo, side)}`;
    const forward = side === RED ? rTo > rFrom : rTo < rFrom;
    const step = Math.abs(rTo - rFrom);
    if (fFrom === fTo) return `${head}${forward ? '进' : '退'}${side === RED ? CN_NUM[step - 1] : step}`;
    return `${head}${forward ? '进' : '退'}${cnFileNumber(fTo, side)}`;
  }

  /* ============================================================
   * 侧栏渲染
   * ============================================================ */
  function setStatus(text, isError) {
    const el = $('xqStatusText');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('status-error', !!isError);
  }

  function setTurnDot(side) {
    const dot = $('xqTurnDot');
    if (dot) dot.classList.toggle('black', side === BLACK);
  }

  function setThinking(on) {
    thinking = on;
    const box = $('xqThinkingIndicator');
    if (box) box.classList.toggle('visible', on);
  }

  function updateMeta() {
    const c = $('xqMoveCount');
    if (c) c.textContent = String(Math.ceil(history.length / 2));
    const lm = $('xqLastMove');
    if (lm) {
      lm.textContent = history.length
        ? `${history[history.length - 1].cn}  ${squareName(history[history.length - 1].from)}-${squareName(history[history.length - 1].to)}`
        : '—';
    }
    const undoBtn = $('xqUndoBtn');
    if (undoBtn) undoBtn.disabled = thinking || history.length === 0;
    const resignBtn = $('xqResignBtn');
    if (resignBtn) resignBtn.disabled = gameOver || thinking || history.length === 0;
  }

  function updateScoreboard() {
    const r = $('xqRedScore'); if (r) r.textContent = String(scores.red);
    const b = $('xqBlackScore'); if (b) b.textContent = String(scores.black);
    const d = $('xqDrawScore'); if (d) d.textContent = String(scores.draw);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderHistory() {
    const list = $('xqHistoryList');
    if (!list) return;
    if (!history.length) {
      list.innerHTML = '<div class="xq-history-empty">还没有走子</div>';
      return;
    }
    const rows = [];
    for (let i = 0; i < history.length; i += 2) {
      const red = history[i];
      const black = history[i + 1];
      rows.push(
        '<div class="xq-history-row">' +
        `<span class="num">${Math.floor(i / 2) + 1}.</span>` +
        `<span class="w">${escapeHtml(red ? red.cn : '')}</span>` +
        `<span class="b">${escapeHtml(black ? black.cn : '')}</span>` +
        '</div>'
      );
    }
    list.innerHTML = rows.join('');
    list.scrollTop = list.scrollHeight;
  }

  function showEngineBadge(text, kind) {
    const el = $('xqEngineBadge');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('ok', 'warn');
    if (kind) el.classList.add(kind);
  }

  function clamp(v, range) {
    if (!Number.isFinite(v)) return null;
    return Math.max(range.min, Math.min(range.max, Math.floor(v)));
  }

  function currentParams() {
    if (preset !== 'custom') {
      const p = PRESETS[preset];
      return { depth: p.depth, timeMs: p.timeMs };
    }
    return customMode === 'depth'
      ? { depth: clamp(custom.depth, CUSTOM_LIMITS.depth), timeMs: 0 }
      : { depth: 0, timeMs: clamp(custom.timeMs, CUSTOM_LIMITS.time) };
  }

  function difficultyHint() {
    if (!window.Godogpaw || window.Godogpaw.state !== 'ready') return '引擎就绪后可选难度';
    const p = currentParams();
    const text = preset === 'custom'
      ? (customMode === 'depth' ? `自定义 · 搜索 ${p.depth} 层` : `自定义 · 每步最多 ${(p.timeMs / 1000).toFixed(1)} 秒`)
      : PRESETS[preset].hint;
    return gameStarted ? `本局已锁定：${text}` : text;
  }

  function updateDifficultyHint() {
    const el = $('xqDepthHint');
    if (el) el.textContent = difficultyHint();
  }

  function lockDifficulty(locked) {
    document.querySelectorAll('#xqDepthGroup .xq-diff-btn').forEach((b) => { b.disabled = locked; });
    document.querySelectorAll('#xqDiffModeGroup .xq-diff-mode').forEach((b) => { b.disabled = locked; });
    const d = $('xqCustomDepth'); if (d) d.disabled = locked;
    const t = $('xqCustomTime'); if (t) t.disabled = locked;
  }

  /* ============================================================
   * 对局流程
   * ============================================================ */
  function loadScores() {
    try {
      const raw = localStorage.getItem(SCORE_KEY);
      if (raw) {
        const o = JSON.parse(raw);
        scores = { red: o.red | 0, black: o.black | 0, draw: o.draw | 0 };
      }
    } catch (e) { console.warn('[xiangqi] 战绩读取失败:', e.message); }
    updateScoreboard();
  }

  function saveScores() {
    try { localStorage.setItem(SCORE_KEY, JSON.stringify(scores)); }
    catch (e) { console.warn('[xiangqi] 战绩保存失败:', e.message); }
  }

  function recordResult(kind) {
    if (resultShown) return;
    resultShown = true;
    scores[kind] += 1;
    saveScores();
    updateScoreboard();
  }

  function applyBoard(data) {
    boardData = data.board;
    sideToMove = data.sideToMove;
    inCheck = data.inCheck;
    gameOver = data.isGameOver;
    lastMove = (data.lastMoveFrom >= 0 && data.lastMoveTo >= 0)
      ? { from: data.lastMoveFrom, to: data.lastMoveTo }
      : null;
  }

  function readBoard() {
    try { return window.Godogpaw.getBoard(); }
    catch (e) { setStatus('读盘面失败：' + e.message, true); return null; }
  }

  function newGame() {
    if (!window.Godogpaw || window.Godogpaw.state !== 'ready') {
      setStatus('引擎还没就绪，稍候再试', true);
      return;
    }
    let data;
    try { data = window.Godogpaw.newGame(); }
    catch (e) { setStatus('起局失败：' + e.message, true); return; }

    history = [];
    boardBeforeLastHuman = null;
    selected = -1;
    legalTargets = [];
    thinking = false;
    gameOver = false;
    resultShown = false;
    gameStarted = false;
    flipped = false;
    moveCount = 0;
    setThinking(false);
    applyBoard(data);
    lockDifficulty(false);
    updateDifficultyHint();
    updateMeta();
    renderHistory();
    render();
    updateStatus();
    dbg('new-game', { sideToMove });
  }

  function updateStatus() {
    setTurnDot(sideToMove);
    if (gameOver) return;   // 由 handleNoMoves 收尾
    if (thinking) return;   // 显示「AI 正在思考…」，别覆盖
    if (inCheck) setStatus(sideToMove === RED ? '红方被将军 —— 必须应将' : '黑方被将军 —— 必须应将');
    else setStatus(sideToMove === RED ? '你的回合 · 你执红先行' : 'AI 回合');
  }

  /** 引擎说没着法了。中国象棋里「无着可走」一律判负（将死与困毙同判负） */
  function handleNoMoves() {
    gameOver = true;
    if (sideToMove === RED) {
      setStatus('红方无着可走 —— 黑方胜（将死或困毙）', true);
      recordResult('black');
    } else {
      setStatus('黑方无着可走 —— 红方胜（将死或困毙）', true);
      recordResult('red');
    }
    setThinking(false);
    updateMeta();
    dbg('no-moves', { sideToMove });
  }

  function refresh() {
    const data = readBoard();
    if (!data) return;
    applyBoard(data);
    updateMeta();
    render();
    if (gameOver) { handleNoMoves(); return; }
    updateStatus();
  }

  async function aiMove() {
    if (gameOver || !window.Godogpaw.ready) return;
    const gen = ++searchGen;
    const p = currentParams();
    dbg('ai-start', { gen, params: p });
    setThinking(true);
    setStatus('AI 正在思考…');
    updateMeta();
    render();
    // 让浏览器先把「玩家那一步」画出来，再进同步搜索
    await new Promise((r) => setTimeout(r, 60));
    if (gen !== searchGen) { dbg('ai-abort', { gen, searchGen }); return; }

    let mv = '';
    const t0 = Date.now();
    try {
      mv = await window.Godogpaw.search(p.depth, p.timeMs);
    } catch (e) {
      setThinking(false);
      setStatus('AI 出错了：' + e.message, true);
      console.error('[xiangqi] AI 搜索失败:', e);
      dbg('ai-error', { message: e.message });
      updateMeta();
      return;
    }
    if (gen !== searchGen) { dbg('ai-abort-after', { gen, searchGen }); return; }
    const ms = Date.now() - t0;
    dbg('ai-result', { mv, ms });

    if (!mv) {
      setThinking(false);
      handleNoMoves();
      return;
    }
    recordEngineMove(mv, ms);
    setThinking(false);
    refresh();
    dbg('ai-done', {
      sideToMove, inCheck, gameOver,
      last: lastMove ? [lastMove.from, lastMove.to] : null,
      rows: history.length,
      by: history.map((h) => h.by).join(','),
    });
  }

  /** 引擎已经自己落子了，这里只把状态读回来并记录走子 */
  function recordEngineMove(mv, ms) {
    const data = readBoard();
    if (!data) return;
    const from = data.lastMoveFrom;
    const to = data.lastMoveTo;
    if (from < 0 || to < 0) {
      console.warn('[xiangqi] 引擎返回了着法但盘面里没有 lastMove:', mv);
      return;
    }
    // 记谱要用**走子前**的棋盘：此刻 boardData 还是走子前那一份
    const cn = chineseNotation(from, to);
    history.push({ from, to, cn, ms, by: 'ai' });
    moveCount = history.length;
    applyBoard(data);
    const info = $('xqEngineInfo');
    if (info) info.textContent = `最近一手 ${squareName(from)}-${squareName(to)} · ${(ms / 1000).toFixed(2)}s`;
    updateMeta();
    renderHistory();
    render();
    updateStatus();
  }

  function selectSquare(sq) {
    let targets = [];
    try { targets = window.Godogpaw.movesFrom(sq); }
    catch (e) { setStatus('取合法着法失败：' + e.message, true); return; }
    selected = sq;
    legalTargets = targets;
    render();
    if (!targets.length) setStatus(`${GLYPH[boardData[sq]] || '该子'} 这一步没有可走的着法`);
    else updateStatus();
  }

  function playMove(from, to) {
    const captured = boardData[to];
    const cn = chineseNotation(from, to);
    // 记下走子前的盘面：悔棋要靠它判断"撤到位了没有"
    boardBeforeLastHuman = JSON.stringify(boardData);
    let ok = false;
    try { ok = window.Godogpaw.move(from, to); }
    catch (e) { setStatus('走子失败：' + e.message, true); return; }
    if (!ok) {
      console.warn('[xiangqi] 引擎拒绝了这步棋:', squareName(from), squareName(to));
      setStatus('这一步不合规则，换个落点');
      selected = -1;
      legalTargets = [];
      render();
      return;
    }
    selected = -1;
    legalTargets = [];
    history.push({ from, to, cn, captured, by: 'me' });
    moveCount = history.length;
    gameStarted = true;
    lockDifficulty(true);
    updateDifficultyHint();
    // 立刻把引擎状态读回来，让 sideToMove 等字段与真实轮次一致
    // （AI 应手前页面显示「AI 正在思考…」，不由 updateStatus 覆盖）
    const data = readBoard();
    if (data) applyBoard(data);
    updateMeta();
    renderHistory();
    render();
    if (gameOver) { handleNoMoves(); return; }
    aiMove();
  }

  function undo() {
    if (thinking) return;
    if (!history.length) return;
    searchGen++;               // 作废正在进行的 AI 搜索
    setThinking(false);

    const target = boardBeforeLastHuman;   // 撤到这个盘面为止（上次玩家落子之前）
    const before = history.length;
    let done = 0;
    try {
      // 最多撤 3 手（AI 一手 + 玩家一手，留一次余量），撤到位或撤不动就停
      for (let i = 0; i < 3; i++) {
        if (target && JSON.stringify(boardData) === target && done > 0) break;
        if (!window.Godogpaw.undo()) break;
        done++;
        const data = window.Godogpaw.getBoard();
        applyBoard(data);
        if (target && JSON.stringify(boardData) === target) break;
      }
      if (done === 0) {
        // 引擎历史已空却还能点到悔棋 —— 说明记录与引擎脱节，显式暴露，不静默失败
        console.warn('[xiangqi] 悔棋没撤掉任何一手：引擎历史为空，本地记录还有', history.length, '手');
        dbg('undo-empty', { historyLen: history.length, sideToMove });
        setStatus('引擎里已经退到开局了，没有可撤的着手', true);
        history = [];
        boardBeforeLastHuman = null;
        updateMeta();
        renderHistory();
        return;
      }
      // 记录按"引擎实际撤了几手"裁剪
      history.splice(Math.max(0, history.length - done), done);
      boardBeforeLastHuman = null;   // 已经退回到更早的局面，目标失效
    } catch (e) {
      setStatus('悔棋失败：' + e.message, true);
      dbg('undo-error', { message: e.message, done });
      return;
    }
    dbg('undo', { done, before, after: history.length, sideToMove });

    selected = -1;
    legalTargets = [];
    gameOver = false;
    resultShown = false;
    render();
    renderHistory();
    updateMeta();
    updateStatus();
  }

  function resign() {
    if (gameOver || thinking) return;
    if (!history.length) { setStatus('还没走子，先下一手再说'); return; }
    searchGen++;
    setThinking(false);
    gameOver = true;
    setStatus('你认输了 —— 黑方胜', true);
    recordResult('black');
    updateMeta();
    render();
    dbg('resign', {});
  }

  function flip() {
    flipped = !flipped;
    render();
    dbg('flip', { flipped });
  }

  function copyStartFen() {
    const fen = window.Godogpaw.START_FEN;
    const done = () => setStatus('标准开局 FEN 已复制到剪贴板');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(fen).then(done).catch(() => { window.prompt('复制这个 FEN：', fen); });
    } else {
      window.prompt('复制这个 FEN：', fen);
    }
  }

  /* ============================================================
   * 事件绑定（只绑一次）
   * ============================================================ */
  function bindNumber(id, key) {
    const el = $(id);
    if (!el) return;
    const range = key === 'depth' ? CUSTOM_LIMITS.depth : CUSTOM_LIMITS.time;
    const commit = () => {
      if (el.value.trim() === '') { el.classList.remove('invalid'); updateDifficultyHint(); return; }
      const raw = Number(el.value);
      const v = clamp(raw, range);
      const outOfRange = !Number.isFinite(raw) || v !== Math.floor(raw);
      el.classList.toggle('invalid', outOfRange);
      if (v !== null) {
        if (key === 'depth') custom.depth = v; else custom.timeMs = v;
        if (outOfRange) el.value = String(v);   // 回显实际生效值，让人看见差别
      }
      updateDifficultyHint();
    };
    el.addEventListener('change', commit);
    el.addEventListener('input', () => { el.classList.remove('invalid'); });
  }

  function bindEvents() {
    if (engineBound) return;
    engineBound = true;

    canvas.addEventListener('click', handleClick);

    $('xqRestartBtn')?.addEventListener('click', () => { searchGen++; setThinking(false); newGame(); });
    $('xqUndoBtn')?.addEventListener('click', () => {
      dbg('undo-click', { thinking, historyLen: history.length, sideToMove, disabled: $('xqUndoBtn').disabled });
      undo();
    });
    $('xqResignBtn')?.addEventListener('click', resign);
    $('xqFlipBtn')?.addEventListener('click', flip);
    $('xqCopyFenBtn')?.addEventListener('click', copyStartFen);

    document.querySelectorAll('#xqDepthGroup .xq-diff-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        preset = btn.dataset.preset;
        document.querySelectorAll('#xqDepthGroup .xq-diff-btn').forEach((b) => b.classList.toggle('active', b === btn));
        $('xqCustomDiff')?.classList.toggle('hidden', preset !== 'custom');
        updateDifficultyHint();
        dbg('preset', { preset });
      });
    });

    document.querySelectorAll('#xqDiffModeGroup .xq-diff-mode').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        customMode = btn.dataset.mode;
        document.querySelectorAll('#xqDiffModeGroup .xq-diff-mode').forEach((b) => b.classList.toggle('active', b === btn));
        document.querySelector('#xqCustomDiff [data-field="depth"]')?.classList.toggle('hidden', customMode !== 'depth');
        document.querySelector('#xqCustomDiff [data-field="time"]')?.classList.toggle('hidden', customMode !== 'time');
        updateDifficultyHint();
        dbg('custom-mode', { customMode });
      });
    });

    bindNumber('xqCustomDepth', 'depth');
    bindNumber('xqCustomTime', 'time');

    $('xqHistoryToggle')?.addEventListener('click', (e) => {
      const list = $('xqHistoryList');
      if (!list) return;
      const open = list.classList.toggle('open');
      e.currentTarget.textContent = open ? '走子记录 ▲' : '走子记录 ▼';
    });

    // 断网/恢复：只提示，不打断对局
    window.addEventListener('offline', () => setStatus('已断网 —— 引擎和棋盘都在本机，照常可玩'));
    window.addEventListener('online', updateStatus);
  }

  /**
   * 带兜底的点击处理：任何未预料的异常都要显示出来 + 进埋点。
   * （教训：AI 那段曾因 `let` 暂时性死区抛错，异常被事件系统吞掉，
   *   表现成「AI 永远不走子」而控制台一片安静。）
   */
  function handleClick(ev) {
    try {
      onBoardClick(ev);
    } catch (e) {
      console.error('[xiangqi] 点击处理抛错:', e);
      dbg('click-error', { message: e.message, stack: (e.stack || '').split('\n').slice(0, 3) });
      setStatus('这步操作出错了：' + e.message, true);
    }
  }

  function onBoardClick(ev) {
    dbg('click', {
      x: ev.clientX, y: ev.clientY, thinking, gameOver,
      ready: window.Godogpaw.ready, gState: window.Godogpaw.state, sideToMove,
      err: window.Godogpaw.error ? window.Godogpaw.error.message : null,
    });
    if (thinking || gameOver) return;
    if (!window.Godogpaw.ready) { setStatus('引擎还没就绪', true); return; }
    if (sideToMove !== RED) return;   // 玩家固定执红

    const rect = canvas.getBoundingClientRect();
    const scaleX = LOGICAL_W / rect.width;
    const scaleY = LOGICAL_H / rect.height;
    const sq = squareAt((ev.clientX - rect.left) * scaleX, (ev.clientY - rect.top) * scaleY);
    dbg('hit', { rect: [rect.left, rect.top, rect.width, rect.height], sq });
    if (sq < 0) { selected = -1; legalTargets = []; render(); return; }

    const piece = boardData[sq];
    const ownPiece = piece >= 1 && piece <= 7;

    if (selected < 0) {
      if (ownPiece) selectSquare(sq);
      return;
    }
    if (sq === selected) { selected = -1; legalTargets = []; render(); return; }
    if (legalTargets.includes(sq)) { playMove(selected, sq); return; }
    if (ownPiece) { selectSquare(sq); return; }
    selected = -1;
    legalTargets = [];
    render();
  }

  /* ============================================================
   * 启动
   * ============================================================ */
  function init() {
    if (initialized) { render(); return; }
    if (!window.Godogpaw) {
      console.error('[xiangqi] 找不到 window.Godogpaw，检查 js/lib/godogpaw/godogpaw-bridge.js 是否加载');
      return;
    }
    if (!setupCanvas()) { console.error('[xiangqi] 找不到 #xqCanvas'); return; }
    initialized = true;

    loadScores();
    bindEvents();
    render();
    setStatus('正在加载引擎…');
    updateMeta();

    window.Godogpaw.on('statechange', (s) => {
      dbg('engine-state', { state: s.state, error: s.error ? s.error.message : null });
      if (s.state === 'ready') {
        showEngineBadge('已就绪 · godogpaw', 'ok');
        const info = $('xqEngineInfo');
        if (info) info.textContent = '本地 WASM · 无需联网';
        lockDifficulty(false);
        newGame();
      } else if (s.state === 'loading') {
        showEngineBadge('加载中…', 'warn');
        updateDifficultyHint();
      } else if (s.state === 'crashed') {
        showEngineBadge('引擎已停止', 'warn');
        setStatus('引擎意外退出（Go runtime 已停止）。刷新页面即可重开。', true);
      } else if (s.state === 'error') {
        showEngineBadge('加载失败', 'warn');
        setStatus('引擎加载失败：' + (s.error ? s.error.message : '未知原因'), true);
      }
    });
    window.Godogpaw.on('crash', (c) => {
      console.error('[xiangqi] 引擎崩溃:', c);
      setThinking(false);
      updateMeta();
    });

    showEngineBadge('加载中…', 'warn');
    window.Godogpaw.load().catch((e) => {
      console.error('[xiangqi] 引擎加载失败:', e);
      setStatus('引擎加载失败：' + e.message, true);
    });
  }

  window.XiangqiApp = { init };
})();
