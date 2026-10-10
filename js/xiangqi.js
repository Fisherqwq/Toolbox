/**
 * 中国象棋 · 页面逻辑
 *
 * 结构与 js/chess.js 保持一致：单例 IIFE、canvas + DPR、Worker 承担思考、
 * gen 计数器丢弃过期结果、难度开局后锁定。
 *
 * 分工：
 *   规则与棋盘绘制  js/xiangqi-engine/zh-chess.browser.min.js（zh-chess，MIT）
 *   引擎            象眼 ElephantEye，走 js/xiangqi-worker.js（经典 Worker，UCCI）
 *
 * ⚠ 坐标约定（zh-chess 的内部坐标，实测确认）：
 *   x ∈ [0,8] 是 9 条纵线，y ∈ [0,9] 是 10 条横线。
 *   y=0 是**黑方底线**，y=9 是**红方底线**（红帅在 (4,9)）。
 *   初始局面红方 16 子、44 个合法着法，与公开棋谱一致。
 *
 * ⚠ 两个实测踩出来的坑（写在这里防止后来者重蹈）：
 *   1. setPenCodeList 只接受「棋盘段 + 行棋方段」，行棋方段取值只有 w / b。
 *      传纯棋盘串或 r / RED 都会抛「不符合 PEN 棋盘布局代码格式」。
 *   2. update(from,to,side,**false**) **不会推进棋盘**，只把 currentSide 翻过去。
 *      拿它做 perft 会在同一局面反复计数（perft(2) 会假成 44×44=1936）。
 *
 * ⚠ isGameOver() 不做「无着即负」的推导（实测：三车封死帅时它仍返回 false），
 *   所以终局判定必须自己来，见 hasNoLegalMove()。
 */
(function () {
  'use strict';

  const ZhChess = window.ZhChess;

  /* ============================================================
   * 常量
   * ============================================================ */
  const COLS = 9;              // 纵线数
  const ROWS = 10;             // 横线数
  const CANVAS = 640;          // canvas 逻辑边长（CSS 像素）
  const MARGIN = 44;           // 外边距：坐标 + 余量
  const CELL_X = (CANVAS - MARGIN * 2) / (COLS - 1);   // 纵线间距 69
  const CELL_Y = (CANVAS - MARGIN * 2) / (ROWS - 1);   // 横线间距 61.33
  const DPR = Math.min(window.devicePixelRatio || 1, 2);

  const START_PEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR';

  /**
   * 引擎：象眼 ElephantEye（js/lib/eleeye/，两个文件必须同目录）。
   * 单线程构建，不需要 COOP/COEP 响应头。
   */
  const ENGINE_JS = 'js/lib/eleeye/eleeye.js';
  const ENGINE_WASM = 'js/lib/eleeye/eleeye.wasm';
  const ENGINE_REPO = 'https://github.com/billzi2016/Chinese-Chess-AI';

  // 棋子配色：红黑同字形，靠颜色区分（与象棋惯例一致）
  const RED = 'RED';
  const BLACK = 'BLACK';

  /* ============================================================
   * 状态
   * ============================================================ */
  let game = null;              // zh-chess 实例
  let history = [];             // [{ from, to, side, piece, san }]
  let lastMove = null;          // { from:{x,y}, to:{x,y} }
  let selected = null;          // 选中的格子 {x,y}
  let legalTargets = [];        // 选中后的合法落点 [{x,y,captured}]
  let thinking = false;
  let gameOver = false;
  let playerSide = RED;         // 玩家执红先行
  let orientation = RED;        // 棋盘朝向：RED = 红方在下
  let gen = 0;
  let gameStarted = false;      // 是否已走出第一步（锁难度用）
  let engineReady = false;
  let badgeText = '检测中…';
  let badgeWarn = true;
  let badgeLoading = false;
  let thinkTimer = null;
  let scores = { r: 0, b: 0, d: 0 };
  const SCORE_KEY = 'xiangqi-scores-v1';

  let canvas, ctx, bgCanvas = null;
  let worker = null;
  let initialized = false;

  /**
   * 难度预设 = 引擎搜索深度。
   *
   * 为什么只有深度没有 Elo / 时间：
   *   · 象眼没有 UCI_LimitStrength / UCI_Elo 这类限强选项
   *   · 实测它**只认 `go depth`**，`go movetime` / `go time` / `go nodes`
   *     都不会返回（阻塞）
   * 所以棋力只能靠深度表达。下面三个数值是实测耗时（Node，同一局面）：
   *   depth 4 ≈ 13ms · 6 ≈ 56ms · 8 ≈ 771ms
   * 浏览器与 Node 有差异，实测四档选 4/6/8/10：
   *   初级几乎秒回，中级半秒，高级约一秒，最高档留给愿意等的玩家。
   */
  const DIFFICULTY = {
    easy:   { depth: 4,  label: '初级' },
    normal: { depth: 6,  label: '中级' },
    hard:   { depth: 8,  label: '高级' },
  };
  let preset = 'normal';

  /**
   * 自定义难度。
   *
   * 只有一个参数：搜索深度。理由同 DIFFICULTY —— 引擎不支持时间和限强，
   * 硬塞一个「每步思考毫秒」进去只会变成骗人的开关（设了也不生效）。
   * 上限 30 层：实测 depth 10 已经要 5 秒，再往上只适合挂着算。
   */
  const CUSTOM = {
    depth: 10,          // 1..30
  };
  const CUSTOM_LIMITS = {
    depth: { min: 1, max: 30 },
  };

  const $ = (id) => document.getElementById(id);
  const other = (s) => (s === RED ? BLACK : RED);
  const pt = (p) => ({ x: p.x, y: p.y });

  /* ============================================================
   * 坐标变换
   *
   * 渲染与命中检测**共用**下面这两个函数 —— chess.js 那次返工 4 轮
   * 的根因就是渲染直接拿棋盘坐标当屏幕坐标，翻转后两者悄悄错开。
   * ============================================================ */

  /** 棋盘坐标 -> 画布像素中心 */
  function cellCenter(x, y) {
    if (orientation === RED) {
      return { px: MARGIN + x * CELL_X, py: MARGIN + (ROWS - 1 - y) * CELL_Y };
    }
    return { px: MARGIN + (COLS - 1 - x) * CELL_X, py: MARGIN + y * CELL_Y };
  }

  /** 画布像素 -> 棋盘坐标（cellCenter 的逆变换）；越界返回 null */
  function pointAt(px, py) {
    const c = Math.round((px - MARGIN) / CELL_X);
    const r = Math.round((py - MARGIN) / CELL_Y);
    if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return null;
    if (Math.abs(px - (MARGIN + c * CELL_X)) > CELL_X / 2) return null;
    if (Math.abs(py - (MARGIN + r * CELL_Y)) > CELL_Y / 2) return null;
    return orientation === RED
      ? { x: c, y: ROWS - 1 - r }
      : { x: COLS - 1 - c, y: r };
  }

  /** 鼠标事件 -> 棋盘坐标 */
  function eventToPoint(e) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return null;
    const px = (e.clientX - rect.left) / rect.width * CANVAS;
    const py = (e.clientY - rect.top) / rect.height * CANVAS;
    return pointAt(px, py);
  }
/* ============================================================
   * 棋盘底纹：木纹 + 网格 + 河界 + 九宫斜线 + 坐标（离屏画一次）
   * ============================================================ */

  const BOARD = {
    face: '#e8c88c',
    faceDeep: '#dcb478',
    grid: 'rgba(90, 56, 24, 0.55)',
    frame: '#5b3a1c',
    river: 'rgba(90, 56, 24, 0.62)',
    coord: 'rgba(80, 48, 20, 0.8)',
  };

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function buildBoardBackground() {
    bgCanvas = document.createElement('canvas');
    bgCanvas.width = CANVAS * DPR;
    bgCanvas.height = CANVAS * DPR;
    const g = bgCanvas.getContext('2d');
    g.scale(DPR, DPR);

    // 木纹底
    const wood = g.createLinearGradient(0, 0, CANVAS, CANVAS);
    wood.addColorStop(0, BOARD.face);
    wood.addColorStop(1, BOARD.faceDeep);
    g.fillStyle = wood;
    g.fillRect(0, 0, CANVAS, CANVAS);

    const rand = mulberry32(20261005);
    g.strokeStyle = 'rgba(120, 78, 36, 0.05)';
    g.lineWidth = 1;
    for (let i = 0; i < 70; i++) {
      const y = rand() * CANVAS;
      const amp = 1.5 + rand() * 4;
      g.beginPath();
      g.moveTo(-10, y);
      for (let x = 0; x <= CANVAS + 10; x += 24) {
        g.lineTo(x, y + Math.sin(x * 0.02 + i * 1.7) * amp);
      }
      g.stroke();
    }

    const left = MARGIN;
    const right = MARGIN + CELL_X * (COLS - 1);
    const top = MARGIN;
    const bottom = MARGIN + CELL_Y * (ROWS - 1);
    const riverY = MARGIN + CELL_Y * 4.5;      // 楚河汉界正好在正中间

    // 横线：10 条全画通
    g.strokeStyle = BOARD.grid;
    g.lineWidth = 1.2;
    for (let r = 0; r < ROWS; r++) {
      const y = top + r * CELL_Y;
      g.beginPath();
      g.moveTo(left, y);
      g.lineTo(right, y);
      g.stroke();
    }

    // 纵线：中间 7 列被楚河汉界断开（象棋规矩），最外两条贯通
    for (let c = 0; c < COLS; c++) {
      const x = left + c * CELL_X;
      g.beginPath();
      if (c === 0 || c === COLS - 1) {
        g.moveTo(x, top);
        g.lineTo(x, bottom);
      } else {
        g.moveTo(x, top);
        g.lineTo(x, riverY);
        g.moveTo(x, riverY);
        g.lineTo(x, bottom);
      }
      g.stroke();
    }

    // 九宫斜线（上下各一组）
    const px0 = MARGIN + CELL_X * 3;
    const px1 = MARGIN + CELL_X * 5;
    g.strokeStyle = BOARD.grid;
    g.lineWidth = 1.2;
    [[bottom - CELL_Y * 2, bottom], [top, top + CELL_Y * 2]].forEach(([y0, y1]) => {
      g.beginPath();
      g.moveTo(px0, y0); g.lineTo(px1, y1);
      g.moveTo(px1, y0); g.lineTo(px0, y1);
      g.stroke();
    });

    // 兵位与炮位的角标（象棋记谱习惯）
    const marks = [
      [1, 2], [7, 2], [0, 3], [2, 3], [4, 3], [6, 3], [8, 3],
      [1, 7], [7, 7], [0, 6], [2, 6], [4, 6], [6, 6], [8, 6],
    ];
    g.strokeStyle = 'rgba(90, 56, 24, 0.45)';
    g.lineWidth = 1.1;
    marks.forEach(([c, r]) => {
      const x = left + c * CELL_X;
      const y = top + r * CELL_Y;
      const s = 5, d = 9, e = 14;
      // 每个象限只画一次，且不伸出棋盘外框
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sy]) => {
        if (sx < 0 && c === 0) return;
        if (sx > 0 && c === COLS - 1) return;
        g.beginPath();
        g.moveTo(x + sx * s, y + sy * s);
        g.lineTo(x + sx * d, y + sy * s);
        g.moveTo(x + sx * d, y + sy * s);
        g.lineTo(x + sx * d, y + sy * e);
        g.stroke();
      });
    });

    // 楚河汉界
    g.fillStyle = BOARD.river;
    g.font = '600 26px "Noto Serif SC", "Songti SC", serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('楚 河', left + CELL_X * 1.6, riverY);
    g.fillText('汉 界', left + CELL_X * 6.4, riverY);

    // 外框
    g.strokeStyle = BOARD.frame;
    g.lineWidth = 3;
    g.strokeRect(left - 8, top - 8, right - left + 16, bottom - top + 16);

    // 坐标：纵线 1..9，横线 1..10，按当前朝向摆放
    g.fillStyle = BOARD.coord;
    g.font = '600 12px "JetBrains Mono", ui-monospace, monospace';
    for (let c = 0; c < COLS; c++) {
      const fileIdx = orientation === RED ? c : COLS - 1 - c;
      g.fillText(String(fileIdx + 1), left + c * CELL_X, bottom + 24);
    }
    for (let r = 0; r < ROWS; r++) {
      const rankIdx = orientation === RED ? ROWS - 1 - r : r;
      g.fillText(String(rankIdx + 1), left - 24, top + r * CELL_Y);
    }
  }

/* ============================================================
   * 渲染
   * ============================================================ */
  const PIECE_COLORS = {
    red:   { face: '#f6e3b8', edge: '#b8860b', text: '#b3261e' },
    black: { face: '#f0e6d2', edge: '#5a4632', text: '#241c14' },
  };
  const MARK = {
    lastMove: 'rgba(217, 135, 63, 0.34)',
    selected: 'rgba(47, 127, 191, 0.34)',
    legal: 'rgba(31, 92, 140, 0.42)',
    legalCapture: 'rgba(190, 40, 40, 0.55)',
  };

  /** 取某个格子上的棋子（没有则 null） */
  function pieceAt(x, y) {
    const all = game.getPiecesOfSide(RED).concat(game.getPiecesOfSide(BLACK));
    return all.find((p) => p.x === x && p.y === y) || null;
  }

  /** 黑方棋子用传统字，更符合观感 */
  function traditionalize(name) {
    switch (name) {
      case '帅': return '將';
      case '仕': return '士';
      case '相': return '象';
      case '兵': return '卒';
      case '马': return '馬';
      default: return name;
    }
  }

  function render() {
    if (!ctx) return;
    ctx.clearRect(0, 0, CANVAS, CANVAS);
    if (bgCanvas) ctx.drawImage(bgCanvas, 0, 0, CANVAS, CANVAS);

    // 上一步
    if (lastMove) {
      ctx.fillStyle = MARK.lastMove;
      [lastMove.from, lastMove.to].forEach((p) => {
        const c = cellCenter(p.x, p.y);
        ctx.beginPath();
        ctx.arc(c.px, c.py, CELL_X * 0.42, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // 选中格
    if (selected) {
      const c = cellCenter(selected.x, selected.y);
      ctx.fillStyle = MARK.selected;
      ctx.beginPath();
      ctx.arc(c.px, c.py, CELL_X * 0.44, 0, Math.PI * 2);
      ctx.fill();
    }

    // 合法落点：能吃的画圈，不能吃的画点
    for (const t of legalTargets) {
      const c = cellCenter(t.x, t.y);
      ctx.fillStyle = t.captured ? MARK.legalCapture : MARK.legal;
      ctx.beginPath();
      ctx.arc(c.px, c.py, t.captured ? CELL_X * 0.34 : CELL_X * 0.13, 0, Math.PI * 2);
      ctx.fill();
    }

    // 棋子：遍历棋盘坐标，再经 cellCenter 换算到屏幕
    const pieces = game.getPiecesOfSide(RED).concat(game.getPiecesOfSide(BLACK));
    pieces.forEach((p) => {
      const c = cellCenter(p.x, p.y);
      drawPiece(p, c.px, c.py);
    });

    // 被将军的将帅加圈
    const checked = checkedKing();
    if (checked) {
      const c = cellCenter(checked.x, checked.y);
      ctx.strokeStyle = 'rgba(200, 40, 40, 0.9)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(c.px, c.py, CELL_X * 0.48, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /** 若 side 正被将军，返回其将帅位置，否则 null */
  function checkedKing() {
    // ⚠ zh-chess 没有 isCheck()，判断将军要用 checkGeneralInTrouble(side)。
    //    （写成 game.isCheck 会在 render() 里直接抛错，把整页逻辑带崩 ——
    //     实测症状是引擎探测再也不往下走。）
    if (!isCheck(currentSide())) return null;
    const king = game.getPiecesOfSide(currentSide())
      .find((p) => p.name === '帅' || p.name === '将');
    return king || null;
  }

  function drawPiece(piece, px, py) {
    const isRed = piece.side === RED;
    const col = isRed ? PIECE_COLORS.red : PIECE_COLORS.black;
    const r = Math.min(CELL_X, CELL_Y) * 0.42;

    // 棋子主体
    const grad = ctx.createRadialGradient(px - r * 0.3, py - r * 0.35, r * 0.15, px, py, r);
    grad.addColorStop(0, '#fffaf0');
    grad.addColorStop(1, col.face);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // 双环（象棋棋子的标志）
    ctx.strokeStyle = col.edge;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(px, py, r * 0.78, 0, Math.PI * 2);
    ctx.stroke();

    const label = isRed ? piece.name : traditionalize(piece.name);
    ctx.fillStyle = col.text;
    ctx.font = '700 ' + Math.round(r * 1.12) + 'px "Noto Serif SC", "Songti SC", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, px, py + 1);
  }

  /* ============================================================
   * 交互
   * ============================================================ */

  /** 当前行棋方（zh-chess 的 currentSide 才是真正的行棋方） */
  function currentSide() {
    return game.currentSide;
  }

  /**
   * 内部坐标 -> ICCS 记法（横线用 0..9，实测校准过）。
   *
   * 纵线 a..i 对应 x = 0..8，横线 **0..9** 对应 y = 9..0：
   *     file = x + 1        rank = 9 - y
   *
   * ⚠ 横线基准踩过坑，这里留证据防止再改错：
   *   标准象棋记谱是 1..10（rank = 10 - y），但**这个引擎实际输出 0..9**。
   *   实测（浏览器驱动 worker + 规则引擎对账，同一局面）：
   *     局面「红方炮二平五后、轮到黑方」，引擎回 `b9c7`
   *       rank=9-y  → b9c7 = (1,0)→(2,2)：黑马走日 ✓ 在合法着法表内
   *       rank=10-y → 同样这串不在合法着法表里（起点会落到空格）
   *     所以必须用 9 - y。别按「标准记谱」想当然改回 10 - y。
   *
   * 记法**不随行棋方、也不随棋盘翻转**变化 —— 这是记谱的固定约定。
   *   写成跟着 side/orientation 翻，会把引擎着法解析到别的格子，
   *   症状是页面报「引擎着法异常」且 AI 永远不出第二手。
   */
  function iccs(p) {
    return String.fromCharCode(96 + p.x + 1) + (9 - p.y);
  }

  /** ICCS -> 内部坐标（iccs 的逆变换）；非法返回 null */
  function parseIccs(s) {
    const file = s.charCodeAt(0) - 97;      // 'a' -> 0 .. 'i' -> 8
    const rank = parseInt(s[1], 10);        // '0'..'9'
    if (!(file >= 0 && file < COLS) || !(rank >= 0 && rank < ROWS)) return null;
    return { x: file, y: 9 - rank };
  }

  /** 该方是否已无着可走 —— isGameOver() 不推导这个，必须自己判 */
  function hasNoLegalMove(side) {
    try {
      return game.generateLegalMoves(side).length === 0;
    } catch (e) {
      console.warn('[xiangqi] generateLegalMoves 异常:', e.message);
      return false;
    }
  }

  /** side 是否正被将军（zh-chess 没有 isCheck，用 checkGeneralInTrouble） */
  function isCheck(side) {
    try {
      return !!game.checkGeneralInTrouble(side);
    } catch (e) {
      return false;
    }
  }

  function handleClick(e) {
    if (gameOver || thinking) return;
    if (currentSide() !== playerSide) return;

    const p = eventToPoint(e);
    if (!p) return;

    // 第二次点击：尝试走子
    if (selected) {
      const hit = legalTargets.find((t) => t.x === p.x && t.y === p.y);
      if (hit) {
        applyMove(selected, pt(p));
        return;
      }
    }

    // 选中己方棋子
    const piece = pieceAt(p.x, p.y);
    if (piece && piece.side === playerSide) {
      selectPoint(p);
    } else {
      clearSelection();
      render();
    }
  }

  function selectPoint(p) {
    selected = pt(p);
    legalTargets = game.generateLegalMoves(playerSide)
      .filter((m) => m.from.x === selected.x && m.from.y === selected.y)
      .map((m) => ({ x: m.to.x, y: m.to.y, captured: !!m.captured }));
    render();
  }

  function clearSelection() {
    selected = null;
    legalTargets = [];
  }

  /**
   * 落子。side 参数由调用方给出 —— 不能一律写 playerSide，
   * 因为引擎走棋时轮到的是对方。
   */
  function applyMove(from, to, side) {
    const mover = side || currentSide();
    const piece = pieceAt(from.x, from.y);
    const captured = pieceAt(to.x, to.y);

    let result = null;
    try {
      // post=true 才会真正推进棋盘（post=false 只翻 currentSide）
      result = game.update(from, to, mover, true);
    } catch (e) {
      console.error('[xiangqi] update 抛错:', e.message);
      result = null;
    }
    if (!result || !result.flag) {
      console.warn('[xiangqi] 非法走子被规则引擎拒绝:', iccs(from), iccs(to));
      clearSelection();
      render();
      return false;
    }

    history.push({
      from: pt(from),
      to: pt(to),
      side: mover,
      piece: piece ? piece.name : '',
      captured: captured ? captured.name : null,
      san: iccs(from) + iccs(to),
    });
    lastMove = { from: pt(from), to: pt(to) };

    afterMove();
    return true;
  }

  /** 走完一步后的公共处理：清选中、判终局、触发 AI */
  function afterMove() {
    clearSelection();
    // 走出第一步即视为开局，难度从此锁定
    if (!gameStarted) { gameStarted = true; updateDifficultyLock(); }
    updateMoveCount();
    updateLastMoveText();
    renderHistoryList();
    render();

    // 终局判定：不能只信 isGameOver（实测它不做「无着即负」的推导）
    if (hasNoLegalMove(currentSide())) {
      gameOver = true;
      thinking = false;
      finishGame(currentSide());
      return;
    }

    if (currentSide() === playerSide) {
      updateStatus();
      updateControls();
      return;
    }

    thinking = true;
    updateStatus();
    updateControls();
    askEngine();
  }

/**
 * 收官。
 *
 * @param {string} loserSide 无着可走的一方，即负方
 */
function finishGame(loserSide) {
    let text;
    if (isCheck(loserSide)) {
      text = loserSide === playerSide ? '将死，你输了' : '将死！你赢了';
    } else {
      // 无着可走但没被将军 = 困毙，中国象棋规则里也算负
      text = loserSide === playerSide ? '困毙 · 你输了（无子可动）' : '困毙 · 你赢了（对方无子可动）';
    }
    scores[loserSide === playerSide ? 'b' : 'r']++;
    saveScores();
    updateScoreUI();
    setStatus(text, true);
    updateTurnDot();
    updateControls();
  }

/* ============================================================
   * 引擎
   * ============================================================ */

  /** 当前生效的搜索深度 */
  function currentDepth() {
    if (preset === 'custom') return CUSTOM.depth;
    return (DIFFICULTY[preset] || DIFFICULTY.normal).depth;
  }

  /**
   * 玩家填的值夹进合法区间。
   *
   * 空值单独判掉，不能靠 Number()：Number('') 是 0 且 isFinite(0) 为真，
   * 会把「清空输入框」悄悄变成 depth 1 —— 也就是最弱档。
   */
  function clampCustom(field, raw) {
    const lim = CUSTOM_LIMITS[field];
    if (!lim) return CUSTOM[field];
    if (raw === '' || raw === null || raw === undefined) return CUSTOM[field];
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return CUSTOM[field];
    return Math.min(lim.max, Math.max(lim.min, n));
  }

  /** 给引擎的标准 FEN（zh-chess 只给 PEN 的前两段，补齐后 5 段） */
  function engineFen() {
    return game.getCurrentPenCode(currentSide()) + ' - - 0 1';
  }

  function askEngine() {
    if (!worker) return;
    worker.postMessage({
      type: 'go',
      data: {
        gen,
        fen: engineFen(),
        depth: currentDepth(),
      },
    });
    setEngineThinking(true);
    armThinkWatchdog();
  }

  /**
   * 思考看门狗：引擎可能脚本加载成功却永远不回应，
   * 没有兜底的话界面会一直停在「AI 思考中…」，玩家彻底卡住。
   */
  function armThinkWatchdog() {
    disarmThinkWatchdog();
    const startGen = gen;
    // 必须长于「引擎合法可能花的时间」：自定义 60s 慢慢等时，
    // 到点的应该是引擎而不是看门狗。
    const budget = Math.max(45000, currentDepth() * 6000 + 15000);
    thinkTimer = setTimeout(() => {
      thinkTimer = null;
      if (startGen !== gen || !thinking) return;      // 已换局 / 已走完
      console.warn('[xiangqi] 引擎思考超时');
      thinking = false;
      setEngineThinking(false);
      setStatus('引擎无响应，请点「新对局」重试', true);
      updateControls();
    }, budget);
  }

  function disarmThinkWatchdog() {
    if (thinkTimer) { clearTimeout(thinkTimer); thinkTimer = null; }
  }

  /**
   * 取消思考。
   *
   * ⚠ 象眼是同步阻塞模型（execute_ucci_command 内部跑到搜索结束才返回），
   *   **无法中途打断**，所以这里不发 stop。worker 只会把「新对局/悔棋」的
   *   gen 递增，靠主线程丢弃过期 bestmove 来达到取消效果。
   *   代价：搜索最长要跑完当前深度。实测最深 30 层，但这只在自定义档出现，
   *   而自定义档开局后锁定，所以正常对局碰不到。
   */
  function stopEngine() {
    thinking = false;
    setEngineThinking(false);
    disarmThinkWatchdog();
  }

  function handleEngineMessage(e) {
    const { type, data } = e.data || {};

    if (type === 'ready') {
      engineReady = true;
      // 握手成功此刻才成立。worker 被创建不等于引擎可用。
      //
      // 区分「加载中」与「真出错」：setupEngine() 展示的「正在加载…」本身也带
      // warn=true，若只看 badgeWarn 就永远判成出错，徽标会一直卡在黄色不转绿。
      if (badgeLoading) {
        badgeLoading = false;
        showEngineBadge('已加载 · 象眼', false);
      } else {
        renderBadge();
      }
      // 握手完成后把当前难度补下发一次
      updateDepthHint();
      updateStatus();
      return;
    }

    if (type === 'unavailable') {
      engineReady = false;
      badgeLoading = false;
      showEngineBadge('象眼启动失败', true);
      setEngineMissingHint(false);
      setStatus('象眼启动失败（' + ((data && data.reason) || '未知原因')
        + '）——请确认用 HTTP 打开并强刷', true);
      thinking = false;
      setEngineThinking(false);
      updateControls();
      return;
    }

    if (type === 'info') {
      if (data.gen !== gen) return;                 // 过期
      if (!data.depth) return;
      // 深度留在信息行（它同时是「引擎在动」的唯一信号），分数另收进折叠区
      setEngineInfo('深度 ' + data.depth);
      if (data.score !== undefined) setEngineScore(formatScore(data), data);
      return;
    }

    if (type === 'bestmove') {
      if (data.gen !== gen) return;                 // 重开对局后的过期结果
      thinking = false;
      setEngineThinking(false);
      disarmThinkWatchdog();

      if (!data.move) {
        // 引擎没给着法。只有局面确实已经终局时才判负，
        // 否则（搜索被打断后收到空着法）不能算终局，更不能记进战绩。
        if (hasNoLegalMove(currentSide())) {
          gameOver = true;
          finishGame(currentSide());
        } else {
          setStatus('引擎未返回着法，请点「新对局」重开', true);
          updateControls();
        }
        return;
      }

      const aiSide = other(playerSide);
      const from = parseIccs(data.move.slice(0, 2));
      const to = parseIccs(data.move.slice(2, 4));
      if (!from || !to) {
        console.error('[xiangqi] 引擎着法无法解析:', data.move);
        setStatus('引擎着法异常，请点「新对局」重开', true);
        updateControls();
        return;
      }

      if (!applyMove(from, to, aiSide)) {
        // 引擎给了非法着法：不让它卡死对局，交回玩家
        setStatus('引擎着法异常，请点「新对局」重开', true);
        updateControls();
      }
      return;
    }

    if (type === 'error') {
      if (data.gen !== gen) return;
      thinking = false;
      setEngineThinking(false);
      setStatus('引擎出错：' + (data && data.message), true);
    }
  }

  /**
   * 分数显示。
   *
   * UCCI 的 score 是**整数**且为行棋方视角，转成「红方始终为正」便于阅读。
   * 象眼没有 mate 概念，所以这里不做 M/n 的显示。
   */
  function formatScore(info) {
    if (info.score === undefined) return '';
    const flip = currentSide() === BLACK ? -1 : 1;
    const v = info.score * flip;
    return (v > 0 ? '+' : '') + v;
  }

/* ============================================================
   * 引擎装载
   * ============================================================ */

  /**
   * 探测引擎文件是否存在。
   *
   * 不能只靠 HEAD：不少静态服务器 / CDN / 企业网关对 HEAD 返回 405、501、403，
   * 文件明明在也会被误判成「未下载」。所以 HEAD 拿不准时退回 GET 复核。
   */
  async function fileExists(path) {
    const url = new URL(path, document.baseURI).href;
    if (location.protocol === 'file:') {
      console.warn('[xiangqi] 当前是 file:// 协议，fetch 与 WebAssembly 都会被浏览器拦截。'
        + ' 请用 python3 -m http.server 打开。');
    }
    console.log('[xiangqi] 探测引擎:', url);
    try {
      const head = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      if (head.ok) return true;
      if (head.status === 405 || head.status === 501 || head.status === 403) {
        const get = await fetch(url, { method: 'GET', cache: 'no-store' });
        return get.ok;
      }
      return false;
    } catch (headErr) {
      console.warn('[xiangqi] HEAD 请求异常:', headErr.message);
    }
    try {
      const get = await fetch(url, { method: 'GET', cache: 'no-store' });
      return get.ok;
    } catch (getErr) {
      console.error('[xiangqi] 引擎探测失败。请检查：'
        + '1) 是否用 HTTP 打开（file:// 不行）'
        + '2) js/lib/eleeye/ 下两个文件是否齐全。原因：', getErr.message);
      return false;
    }
  }

  /** 探测象眼两个文件，然后启动（唯一后端） */
  async function setupEngine() {
    // 两个文件缺一不可：胶水没了加载不了，wasm 缺了实例化会失败
    const hasJs = await fileExists(ENGINE_JS);
    const hasWasm = hasJs ? await fileExists(ENGINE_WASM) : false;
    console.log('[xiangqi] 引擎文件：js=' + hasJs + ' wasm=' + hasWasm);

    if (hasJs && hasWasm) {
      // 不能在这里直接写「已加载」：worker 只是被创建了，
      // 真正握手成功（收到 ready）之后才算加载完成。
      showEngineBadge('正在加载象眼…', true);
      badgeLoading = true;
      setEngineMissingHint(false);
      spawnEngine();
    } else {
      showEngineBadge('未安装象眼 · 无法对弈', true);
      setEngineMissingHint(true);
      setStatus('缺少象眼引擎，下方可下载后重试', true);
    }
    updateDepthHint();
  }

  /** 未安装引擎时给出下载指引 */
  function setEngineMissingHint(show) {
    const box = $('xqEngineHelp');
    if (box) box.classList.toggle('hidden', !show);
  }

  /** 启动引擎线程 */
  function spawnEngine() {
    if (worker) {
      try { worker.terminate(); } catch (e) { /* 已退出 */ }
      worker = null;
    }
    // 经典 worker：象眼的 Emscripten 胶水靠 importScripts
    worker = new Worker('js/xiangqi-worker.js');
    worker.onmessage = handleEngineMessage;
    worker.onerror = (e) => {
      console.error('[xiangqi] 引擎线程出错:', e.message || e);
      engineReady = false;
      badgeLoading = false;
      showEngineBadge('象眼启动失败', true);
      setEngineMissingHint(false);
      setStatus('象眼线程启动失败——请用 HTTP 打开并强刷（Ctrl+Shift+R）', true);
      thinking = false;
      setEngineThinking(false);
      updateControls();
    };
    // ⚠ 顺序要紧：必须先重置状态、再发 boot。
    //   反过来的话，worker 的 ready 消息可能在 postMessage 与 initEngineState()
    //   之间到达，被 initEngineState() 里的 engineReady=false 覆盖掉，
    //   症状是「引擎明明就绪、徽标却一直停在『正在加载…』」。
    // 真正重建 worker 了，才重置就绪态与徽标
    engineReady = false;
    badgeLoading = true;
    renderBadge();
    initEngineState();
    worker.postMessage({ type: 'boot' });
  }

  /**
   * 把新局面的代数与 FEN 同步给 worker。
   *
   * ⚠ 这里**不能**顺手把 engineReady 置 false。
   *   象眼的 init 消息只是记代数，不会让 worker 重新握手、也不会再发一次 ready。
   *   一旦置 false，悔棋或「新对局」之后引擎明明活着，
   *   状态却永远显示未就绪（实测：走 6 轮后点悔棋，engineReady 变 false）。
   *
   *   只有 spawnEngine()（真正重建 worker）才需要重置就绪态。
   */
  function initEngineState() {
    if (worker) worker.postMessage({ type: 'init', data: { gen, fen: engineFen() } });
  }

/* ============================================================
   * UI
   * ============================================================ */
  function setStatus(text, isError) {
    const el = $('xqStatusText');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('status-error', !!isError);
  }

  function updateStatus() {
    updateTurnDot();
    if (gameOver) return;
    if (thinking) { setStatus('AI 思考中…'); return; }
    setStatus(currentSide() === RED ? '红方回合 · 你走' : '黑方回合 · AI 走');
  }

  function setEngineThinking(on) {
    const el = $('xqThinkingIndicator');
    if (el) el.classList.toggle('visible', !!on);
  }

  function setEngineInfo(text) {
    const el = $('xqEngineInfo');
    if (el) el.textContent = text;
  }

  /**
   * 评估分数：写进**默认收起**的面板。
   *
   * 为什么藏起来：深度是「引擎算到第几层」，属于进度反馈，盯着无害；
   * 分数是「谁更优」，一直摆在眼前容易让人照着分数下棋，反而不看局面。
   *
   * 收起状态下也照样更新 —— 否则展开时会看到上一手的旧分数。
   */
  function setEngineScore(text, info) {
    const el = $('xqEvalScore');
    if (!el || !text) return;
    el.textContent = text;
    // formatScore 已按「红方始终为正」翻转过（见那里的 currentSide 归一化），
    // 所以这里的正负可直接用于染色。
    const v = info.score || 0;
    el.classList.toggle('adv', v > 0);
    el.classList.toggle('dis', v < 0);
  }

  /** 清空分数：新对局 / 悔棋时用，避免留着上一手的评估值 */
  function resetEngineScore() {
    const el = $('xqEvalScore');
    if (!el) return;
    el.textContent = '—';
    el.classList.remove('adv', 'dis');
  }

  /** 记录徽标文案/告警态（真正上色交给 renderBadge，便于 ready 后重绘） */
  function showEngineBadge(text, warn) {
    badgeText = text;
    badgeWarn = !!warn;
    renderBadge();
  }

  function renderBadge() {
    const el = $('xqEngineBadge');
    if (!el) return;
    el.textContent = badgeText;
    el.classList.toggle('warn', badgeWarn || !engineReady);
    el.classList.toggle('ok', !badgeWarn && engineReady);
  }

  /**
   * 难度提示：显示**实际生效**的深度，而不是预设名。
   *
   * 自定义模式下必须回显夹紧后的真值：玩家填 999 层，看到「深度 30」
   * 才知道自己被夹了。
   */
  function updateDepthHint() {
    const el = $('xqDepthHint');
    if (!el) return;
    const p = DIFFICULTY[preset] || DIFFICULTY.normal;
    const depth = preset === 'custom' ? CUSTOM.depth : p.depth;
    // 附上量级预估，让玩家对「这一档要等多久」有预期
    const base = '象眼 搜索 ' + depth + ' 层 · 约 ' + roughSeconds(depth);
    el.textContent = gameStarted ? base + ' · 开局后锁定，点「新对局」可换' : base;
  }

  /**
   * 深度的粗略耗时预估。
   *
   * 实测（Node，开局局面）：4 层 ≈ 13ms · 6 ≈ 56ms · 8 ≈ 771ms · 10 ≈ 5.3s。
   * 增长接近指数，所以这里只给量级，不做精确计时 ——
   * 真实耗时由引擎 info 里的 time 字段实时上报到侧栏。
   */
  function roughSeconds(depth) {
    if (depth <= 4) return '不到 1 秒';
    if (depth <= 6) return '半秒上下';
    if (depth <= 8) return '1 秒上下';
    if (depth <= 10) return '几秒';
    if (depth <= 16) return '十几秒';
    return '半分钟以上';
  }

  /**
   * 重绘自定义难度面板：显隐、输入框回填与越界标红。
   *
   * 只有「深度」一个参数，所以比国际象棋简单：没有模式切换按钮，
   * 也不存在「深度和时间互斥」那类问题。
   */
  function renderCustomPanel() {
    const panel = $('xqCustomDiff');
    if (!panel) return;
    panel.classList.toggle('hidden', preset !== 'custom');

    const input = $('xqCustomDepth');
    if (!input) return;
    const lim = CUSTOM_LIMITS.depth;
    const typed = Number(input.value);
    // 空值是「正在打字或刚清空」的中间态：既不回填、也不标红
    if (input.value !== '' && Number.isFinite(typed)) {
      input.value = CUSTOM.depth;
      // 越界标红：让玩家看见「我填的」和「实际生效的」不是一回事
      input.classList.toggle('invalid', typed < lim.min || typed > lim.max);
    } else {
      input.classList.remove('invalid');
    }
  }

  function updateTurnDot() {
    const el = $('xqTurnDot');
    if (!el || !game) return;
    el.classList.toggle('black', currentSide() === BLACK);
  }

  function updateMoveCount() {
    const el = $('xqMoveCount');
    if (el) el.textContent = Math.ceil(history.length / 2);
  }

  function updateLastMoveText() {
    const el = $('xqLastMove');
    if (!el) return;
    const last = history[history.length - 1];
    el.textContent = last ? last.san : '—';
  }

  function loadScores() {
    try {
      const raw = localStorage.getItem(SCORE_KEY);
      if (raw) scores = Object.assign(scores, JSON.parse(raw));
    } catch (e) { /* 隐私模式下 localStorage 不可用，忽略 */ }
  }

  function saveScores() {
    try {
      localStorage.setItem(SCORE_KEY, JSON.stringify(scores));
    } catch (e) { /* 同上 */ }
  }

  function updateScoreUI() {
    const r = $('xqRedScore');
    const b = $('xqBlackScore');
    const d = $('xqDrawScore');
    if (r) r.textContent = scores.r;
    if (b) b.textContent = scores.b;
    if (d) d.textContent = scores.d;
  }

/* ============================================================
   * 对局控制
   * ============================================================ */
  function newGame() {
    stopEngine();
    gen++;                        // 作废所有在途的引擎结果
    game = new ZhChess.default({});
    game.init();
    game.gameStart(playerSide);
    history = [];
    lastMove = null;
    clearSelection();
    gameOver = false;
    thinking = false;
    gameStarted = false;          // 新对局 → 解锁难度
    orientation = playerSide;
    setEngineThinking(false);
    setEngineInfo('—');
    resetEngineScore();          // 别把上一局的评估值留在栏里
    buildBoardBackground();
    render();
    updateMoveCount();
    updateLastMoveText();
    updateStatus();
    updateControls();
    initEngineState();
  }

  function undoMoves() {
    if (thinking || history.length < 2) return;
    stopEngine();
    gen++;
    // 连撤两步：AI 的一步 + 玩家的一步。
    //
    // ⚠ 顺序不能搞反：先把两步都从 history 里去掉，**再**一次性重建局面。
    //   一边弹一边重建的话，第一次弹完重建出的是「少两手」的中间局面，
    //   那个局面的行棋方正好轮到玩家（看起来对），第二轮再弹再重建才落到最终局面 ——
    //   但因为每轮重建都从 gameStart(playerSide) 起算，最终 currentSide 会错位，
    //   实测症状是「悔棋后玩家点不动，状态显示轮到黑方」。
    const back = Math.min(2, history.length);
    history.splice(history.length - back, back);
    // zh-chess 没有 undo()，只能重放
    rebuildFromHistory();
    const last = history[history.length - 1];
    lastMove = last ? { from: last.from, to: last.to } : null;
    clearSelection();
    gameOver = false;
    setEngineInfo('—');
    resetEngineScore();          // 撤回后上一手的评估值已经无关
    updateMoveCount();
    updateLastMoveText();
    updateStatus();
    updateControls();
    render();
    renderHistoryList();
    initEngineState();
  }

  /**
   * 用 history 重放整盘棋，得到悔棋后的局面。
   *
   * zh-chess 没有 undo()，只能重放 —— 棋盘局面的计算量微不足道，
   * 比在引擎层另找一套撤销逻辑可靠。
   */
  function rebuildFromHistory() {
    const g = new ZhChess.default({});
    g.init();
    g.gameStart(playerSide);
    // history[0] 是玩家第一步，重放到此为止就得到悔棋后的局面。
    // 走完 history.length 步后 currentSide 自然落到正确的行棋方，
    // 不需要额外设置 —— 手动设置反而容易和实际局面不同步。
    for (const h of history) {
      g.update(h.from, h.to, h.side, true);
    }
    game = g;
  }

  function flipBoard() {
    orientation = orientation === RED ? BLACK : RED;
    buildBoardBackground();
    // 翻转后 ICCS 映射也跟着变，把走子记录与上一步重算一遍显示
    renderHistoryList();
    updateLastMoveText();
    render();
  }

  function updateControls() {
    const undo = $('xqUndoBtn');
    if (undo) {
      // AI 思考中不能悔棋，否则会与过期结果打架
      undo.disabled = thinking || history.length < 2;
    }
    updateDifficultyLock();
  }

  /**
   * 开局后锁死难度。
   *
   * 为什么锁：走到一半换档等于随时给自己降难度，赢了不算本事。
   * 只有点「新对局」才解锁 —— 锁定状态用 gameStarted 记，
   * 不看 history，否则一路悔棋回原点会把难度意外解锁。
   */
  function updateDifficultyLock() {
    const lock = gameStarted;
    const group = $('xqDepthGroup');
    if (group) group.querySelectorAll('.xq-diff-btn').forEach((b) => { b.disabled = lock; });
    // 自定义面板里的按钮和输入框同样要锁：只锁预设按钮的话，
    // 选了「自定」之后玩家还能继续改数字，难度就等于没锁。
    const input = $('xqCustomDepth');
    if (input) input.disabled = lock;
    // 锁定文案由 updateDepthHint 统一拼（它才知道实际参数）
    updateDepthHint();
  }

/* ============================================================
   * 初始化
   * ============================================================ */
  function bindEvents() {
    canvas.addEventListener('click', handleClick);

    const restart = $('xqRestartBtn');
    if (restart) restart.addEventListener('click', newGame);

    const undo = $('xqUndoBtn');
    if (undo) undo.addEventListener('click', undoMoves);

    const flip = $('xqFlipBtn');
    if (flip) flip.addEventListener('click', flipBoard);

    const copy = $('xqCopyFenBtn');
    if (copy) {
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(engineFen());
          copy.textContent = '已复制';
        } catch (e) {
          copy.textContent = '复制失败';
        }
        setTimeout(() => { copy.textContent = '复制 FEN'; }, 1200);
      });
    }

    // 难度：只记录预设名，实际深度由 currentDepth() 取
    const group = $('xqDepthGroup');
    if (group) {
      group.addEventListener('click', (e) => {
        const btn = e.target.closest('.xq-diff-btn');
        if (!btn || btn.disabled) return;          // 开局后锁定
        group.querySelectorAll('.xq-diff-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        preset = btn.dataset.preset;
        renderCustomPanel();
        updateDifficultyLock();     // 顺带重绘锁定态与提示
        // 正在思考时切难度：让新参数对下一手生效
        if (thinking) stopEngine();
      });
    }

    // 自定义难度：深度输入。用 input 事件即时生效（键入和滚轮都跟手），
    // change 只做一次收尾规范化 —— 否则边打字边被夹紧，光标位置会乱跳。
    const depthInput = $('xqCustomDepth');
    if (depthInput) {
      depthInput.addEventListener('input', () => {
        CUSTOM.depth = clampCustom('depth', depthInput.value);
        renderCustomPanel();
        updateDifficultyLock();
      });
      // 失焦时把填错的（比如留个空）修正回真值
      depthInput.addEventListener('change', () => { depthInput.value = CUSTOM.depth; });
    }

    // 下载链接统一用 ENGINE_REPO，避免 HTML 与代码两处各写一份而走偏
    const dl = $('xqEngineDownload');
    if (dl) dl.href = ENGINE_REPO;

    // 引擎：重新检测（用户刚放好文件后可点此刷新，不必重开页面）
    const retry = $('xqEngineRetry');
    if (retry) {
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        retry.textContent = '检测中…';
        try {
          await setupEngine();
        } finally {
          retry.disabled = false;
          retry.textContent = '重新检测';
        }
      });
    }

    // 侧栏：评估分数（默认收起）
    // 与国际象棋 / 走子记录同一套：classList.toggle 返回是否已展开，
    // 顺带把文案和 aria-expanded 一起同步 —— 只改样式不改文案的话，
    // 读屏用户听到的永远是「收起」。
    const evalToggle = $('xqEvalToggle');
    if (evalToggle) {
      evalToggle.addEventListener('click', () => {
        const box = $('xqEvalBox');
        if (!box) return;
        const open = box.classList.toggle('open');
        evalToggle.textContent = open ? '收起评估 ▲' : '查看评估 ▼';
        evalToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    }

    // 侧栏：走子记录
    const toggle = $('xqHistoryToggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        const box = $('xqHistoryList');
        if (!box) return;
        box.classList.toggle('open');
        toggle.textContent = box.classList.contains('open') ? '收起走棋记录 ▲' : '走棋记录 ▼';
      });
    }
  }

  function renderHistoryList() {
    const box = $('xqHistoryList');
    if (!box) return;
    if (!box.classList.contains('open')) return;
    let html = '';
    for (let i = 0; i < history.length; i += 2) {
      const n = i / 2 + 1;
      // 翻转棋盘后 ICCS 会变，这里按当前朝向重新算
      const r = history[i] ? iccs(history[i].from) + iccs(history[i].to) : '';
      const b = history[i + 1] ? iccs(history[i + 1].from) + iccs(history[i + 1].to) : '';
      html += '<div class="xq-history-row"><span class="num">' + n + '.</span>'
        + '<span class="w">' + r + '</span><span class="b">' + b + '</span></div>';
    }
    box.innerHTML = html || '<div class="xq-history-empty">还没有走子</div>';
  }

  function init() {
    if (initialized) return;
    initialized = true;

    canvas = $('xqCanvas');
    if (!canvas) return;
    canvas.width = CANVAS * DPR;
    canvas.height = CANVAS * DPR;
    ctx = canvas.getContext('2d');
    ctx.scale(DPR, DPR);

    loadScores();
    updateScoreUI();

    game = new ZhChess.default({});
    game.init();
    game.gameStart(playerSide);

    buildBoardBackground();
    render();
    updateMoveCount();
    updateLastMoveText();
    updateStatus();
    updateControls();
    renderCustomPanel();

    bindEvents();
    setupEngine();
  }

  window.XiangqiApp = {
    init, newGame, undo: undoMoves, flip: flipBoard,
    /**
     * 只读状态快照，控制台里敲 XiangqiApp.state() 就能看。
     * 排查「点不动」这类问题时特别有用。
     */
    state() {
      return {
        thinking, gameOver, gameStarted, engineReady,
        轮次: history.length,
        当前行棋方: game ? currentSide() : null,
        玩家可走: !gameOver && !thinking && !!game && currentSide() === playerSide,
        难度: preset,
        当前深度: currentDepth(),
      };
    },
  };

  // init 内部有 initialized 幂等保护，切回页面重复调用安全
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
