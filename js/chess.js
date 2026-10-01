/**
 * 国际象棋 · 页面逻辑
 *
 * 结构与 js/gomoku.js 保持一致：单例 IIFE、canvas + DPR 渲染、
 * Worker 承担思考、gen 计数器丢弃过期结果。
 *
 * 引擎只有 Stockfish 一个后端（js/chess-worker.js，经典 worker），
 * 依赖 js/lib/stockfish.js —— 单文件 asm.js 构建，二进制已内嵌，
 * 不需要额外的 .wasm 文件，也不需要 COOP/COEP 响应头。
 * 简易引擎已删除：没有引擎文件时明确报错并给出下载指引，不做静默降级。
 */
(function () {
  'use strict';

  // chess.js 是 ES module，由 js/chess-bridge.js 挂到 window 上。
  // 经典脚本与 module 的执行顺序不保证，这里取不到就等 bridge 的信号。
  let Chess = window.Chess;

  function whenChessReady(fn) {
    if (window.Chess) { fn(window.Chess); return; }
    // 事件可能在监听之前就已派发（module 脚本先于经典脚本执行），
    // 所以除了监听信号，还要轮询兜底。
    let done = false;
    const fire = () => {
      if (done || !window.Chess) return;
      done = true;
      document.removeEventListener('chess:ready', fire);
      clearInterval(timer);
      fn(window.Chess);
    };
    document.addEventListener('chess:ready', fire);
    const timer = setInterval(fire, 30);

    // file:// 下 ES module 会被浏览器拦截，window.Chess 永远等不到。
    // 与其停在「加载中…」不给任何提示，不如明确告诉用户怎么修。
    setTimeout(() => {
      if (done || window.Chess) return;
      done = true;
      document.removeEventListener('chess:ready', fire);
      clearInterval(timer);
      const el = document.getElementById('chessStatusText');
      if (el) {
        el.textContent = '规则引擎加载失败：请通过 HTTP 服务访问（如 python3 -m http.server 8000）';
        el.classList.add('status-error');
      }
      const badge = document.getElementById('chessEngineBadge');
      if (badge) {
        badge.textContent = '规则引擎未加载';
        badge.classList.add('warn');
        badge.classList.remove('ok');
      }
    }, 5000);
  }

  /* ============================================================
   * 常量
   * ============================================================ */
  const SQ = 8;
  const CELL = 74;                       // 单格边长（CSS 像素）
  const MARGIN = 34;                     // 棋盘外边距：坐标 + 余量
  const CANVAS_SIZE = MARGIN * 2 + CELL * SQ;   // 688
  const PIECE_R = CELL / 2 - 6;
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  const REDUCE_MOTION = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const ENGINE_JS = 'js/lib/stockfish.js';
  // 引擎的 wasm 也要在位：Niklas Fiekas 的构建靠 scriptDirectory
  // 从脚本同目录自动取 stockfish.wasm，缺了它引擎起不来。
  const ENGINE_WASM = 'js/lib/stockfish.wasm';
  const ENGINE_URL = 'https://github.com/nmrugg/stockfish.js/releases';

  const FILES = 'abcdefgh';
  const GLYPH = { k: '♔', q: '♕', r: '♖', b: '♗', n: '♘', p: '♙' };
  const DARK = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };

  const COLORS = {
    light: '#f0d9b5',
    dark: '#b58863',
    frame: '#2f2a26',
    coord: 'rgba(80, 60, 40, 0.75)',
    lastMove: 'rgba(245, 158, 11, 0.45)',
    selected: 'rgba(59, 130, 246, 0.42)',
    legal: 'rgba(30, 41, 59, 0.26)',
    legalCapture: 'rgba(220, 38, 38, 0.32)',
    check: 'rgba(220, 38, 38, 0.85)',
  };

  /* ============================================================
   * 状态
   * ============================================================ */
  let game = null;                 // chess.js 实例
  let history = [];                // [{ san, lan, from, to, color, piece, captured }]
  let lastMove = null;             // { from, to }
  let selected = null;             // 选中的格子
  let legalTargets = [];           // 选中后的合法落点 [{ to, capture }]
  let thinking = false;
  let gameOver = false;
  let playerColor = 'w';
  let orientation = 'w';           // 棋盘朝向：w = 白方在下
  let gen = 0;                     // 对局代数
  let engineReady = false;
  let badgeText = '检测中…';       // 引擎徽标文案（与样式解耦，便于 ready 后重绘）
  let badgeWarn = true;
  let thinkTimer = null;           // 思考看门狗定时器
  let pendingPromotion = null;     // 升变选择器：{ from, to }

  let canvas, ctx, bgCanvas = null;
  let worker = null;
  let initialized = false;
  let scores = { w: 0, b: 0, d: 0 };
  const SCORE_KEY = 'chess-scores-v1';
  // 难度预设：直接就是 Stockfish 的搜索深度。
  // 简易引擎已删除，这里只剩一套深度。
  const DIFFICULTY = {
    easy:   4,
    normal: 8,
    hard:   14,
  };

  /**
   * 每档的思考时间上限（毫秒）。
   * movetime 是兜底：万一某台机器特别慢，引擎到点也会交出当前最优着法，
   * 而不是让看门狗干等到超时。绝大多数情况下 depth 先到。
   */
  const MOVE_TIME_MS = {
    easy:   2000,
    normal: 8000,
    hard:   20000,
  };
  let preset = 'normal';

  const $ = (id) => document.getElementById(id);
  const sqName = (file, rank) => FILES[file] + (rank + 1);
  const cellX = (file) => MARGIN + file * CELL;
  const cellY = (rank) => MARGIN + rank * CELL;

  /**
   * 棋盘 file/rank -> 屏幕行列（自动处理翻转）。
   *
   * 白方在下（orientation 'w'）时 a1 在左下角：
   *   屏幕行 0 = 第 8 横线，屏幕列 0 = a 线。
   * 黑方在下（orientation 'b'）时 a1 在右上角。
   */
  function boardToScreen(file, rank) {
    return orientation === 'w'
      ? { col: file, row: SQ - 1 - rank }
      : { col: SQ - 1 - file, row: rank };
  }

  /** 屏幕坐标 -> 棋盘 file/rank（boardToScreen 的逆变换） */
  function screenToSquare(col, row) {
    return orientation === 'w'
      ? { file: col, rank: SQ - 1 - row }
      : { file: SQ - 1 - col, rank: row };
  }

  /** 格子名 -> 屏幕像素原点（渲染统一走这里，翻转才生效） */
  function cellOf(sq) {
    const p = parseSquare(sq);
    const s = boardToScreen(p.file, p.rank);
    return { x: cellX(s.col), y: cellY(s.row) };
  }

  /* ============================================================
   * 棋盘背景：木纹 + 格子 + 坐标（离屏只画一次）
   * ============================================================ */
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
    bgCanvas.width = CANVAS_SIZE * DPR;
    bgCanvas.height = CANVAS_SIZE * DPR;
    const g = bgCanvas.getContext('2d');
    g.scale(DPR, DPR);

    const wood = g.createLinearGradient(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    wood.addColorStop(0, '#d8b98c');
    wood.addColorStop(0.5, '#c9a26a');
    wood.addColorStop(1, '#b8905a');
    g.fillStyle = wood;
    g.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // 木纹
    const rand = mulberry32(7);
    for (let i = 0; i < 70; i++) {
      const y = rand() * CANVAS_SIZE;
      const amp = 2 + rand() * 5;
      g.strokeStyle = 'rgba(110, 70, 30, ' + (0.03 + rand() * 0.04).toFixed(3) + ')';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(-10, y);
      for (let x = 0; x <= CANVAS_SIZE + 10; x += 26) {
        g.lineTo(x, y + Math.sin(x * 0.018 + i * 1.7) * amp);
      }
      g.stroke();
    }

    // 格子
    for (let r = 0; r < SQ; r++) {
      for (let f = 0; f < SQ; f++) {
        const dark = (f + r) % 2 === 1;
        g.fillStyle = dark ? COLORS.dark : COLORS.light;
        g.fillRect(MARGIN + f * CELL, MARGIN + r * CELL, CELL, CELL);
      }
    }

    // 细网格：画 SQ+1 条边界线，覆盖整个 8×8 区域
    g.strokeStyle = 'rgba(90, 60, 35, 0.35)';
    g.lineWidth = 1;
    for (let i = 0; i <= SQ; i++) {
      const p = MARGIN + i * CELL + 0.5;
      g.beginPath();
      g.moveTo(MARGIN, p);
      g.lineTo(MARGIN + CELL * SQ, p);
      g.stroke();
      g.beginPath();
      g.moveTo(p, MARGIN);
      g.lineTo(p, MARGIN + CELL * SQ);
      g.stroke();
    }

    // 外框：边长必须是 CELL*SQ，原来写成 CELL*(SQ-1) 少了一格
    g.strokeStyle = COLORS.frame;
    g.lineWidth = 3;
    g.strokeRect(MARGIN, MARGIN, CELL * SQ, CELL * SQ);

    // 坐标：白方在下时 a–h 从左到右、第 1 横线在底部
    g.fillStyle = COLORS.coord;
    g.font = '600 13px -apple-system, "Segoe UI", "PingFang SC", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let col = 0; col < SQ; col++) {
      const file = orientation === 'w' ? col : SQ - 1 - col;
      // 坐标要落在格子中心，不是格子左上角
      g.fillText(FILES[file], cellX(col) + CELL / 2, MARGIN + CELL * SQ + MARGIN / 2 + 1);
    }
    for (let row = 0; row < SQ; row++) {
      const rank = orientation === 'w' ? SQ - 1 - row : row;
      g.fillText(String(rank + 1), MARGIN / 2 - 1, cellY(row) + CELL / 2);
    }
  }

  /* ============================================================
   * 渲染
   * ============================================================ */
  function render() {
    if (!ctx) return;
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    if (bgCanvas) ctx.drawImage(bgCanvas, 0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // 上一步
    if (lastMove) {
      ctx.fillStyle = COLORS.lastMove;
      for (const s of [lastMove.from, lastMove.to]) {
        const c = cellOf(s);
        ctx.fillRect(c.x, c.y, CELL, CELL);
      }
    }

    // 选中格
    if (selected) {
      const c = cellOf(selected);
      ctx.fillStyle = COLORS.selected;
      ctx.fillRect(c.x, c.y, CELL, CELL);
    }

    // 合法落点
    for (const t of legalTargets) {
      const c = cellOf(t.to);
      const cx = c.x + CELL / 2;
      const cy = c.y + CELL / 2;
      ctx.fillStyle = t.capture ? COLORS.legalCapture : COLORS.legal;
      ctx.beginPath();
      if (t.capture) {
        ctx.arc(cx, cy, PIECE_R * 0.92, 0, Math.PI * 2);
        ctx.strokeStyle = COLORS.legalCapture;
        ctx.lineWidth = 4;
        ctx.stroke();
      } else {
        ctx.arc(cx, cy, CELL * 0.17, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 棋子：遍历棋盘格，再经 boardToScreen 换算到屏幕位置
    for (let rank = 0; rank < SQ; rank++) {
      for (let file = 0; file < SQ; file++) {
        const piece = game.get(sqName(file, rank));
        if (!piece) continue;
        const s = boardToScreen(file, rank);
        drawPiece(piece, s.col, s.row);
      }
    }

    // 被将军的王高亮
    if (game.inCheck()) {
      const turn = game.turn();
      const king = game.findPiece({ type: 'k', color: turn })[0];
      if (king) {
        const c = cellOf(king);
        const cx = c.x + CELL / 2;
        const cy = c.y + CELL / 2;
        ctx.strokeStyle = COLORS.check;
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(cx, cy, PIECE_R * 0.95, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  function drawPiece(piece, file, rank) {
    const x = cellX(file) + CELL / 2;
    const y = cellY(rank) + CELL / 2;
    const img = pieceImageFor(piece);

    // 图片已就绪：画 chess.com 同款的 cburnett 棋子
    if (img && img.complete && img.naturalWidth > 0) {
      // SVG 本身留了透明边距，比 viewBox 稍放大一点让棋子更饱满
      const size = CELL * 0.98;
      ctx.drawImage(img, x - size / 2, y - size / 2, size, size);
      return;
    }

    // 兜底：图片还没加载完（或缺失）时用 Unicode 棋子，棋盘不会出现空洞
    const glyph = (piece.color === 'w' ? GLYPH : DARK)[piece.type];
    ctx.font = '600 ' + (PIECE_R * 1.9) + 'px "Segoe UI Symbol", "Apple Symbols", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = piece.color === 'w' ? '#ffffff' : '#0b1220';
    ctx.strokeText(glyph, x, y + 1);
    ctx.fillStyle = piece.color === 'w' ? '#1f2937' : '#0b1220';
    ctx.fillText(glyph, x, y + 1);
  }

  /* ============================================================
   * 棋子图片（chess.com 默认的 cburnett 棋子，CC BY-SA 3.0）
   *
   * 放在 img/chess/{w,b}{K,Q,R,B,N,P}.svg，随站点本地加载，不依赖网络。
   * 图片加载期间先回退到 Unicode 棋子，避免出现空白棋盘。
   * ============================================================ */

  const pieceImages = new Map();   // 'wK' -> HTMLImageElement
  let piecesRepaintQueued = false;

  function pieceImageFor(piece) {
    return pieceImages.get((piece.color === 'w' ? 'w' : 'b') + piece.type.toUpperCase());
  }

  /** 图片是异步加载的，到了要重画一次 */
  function onPieceImageReady() {
    if (piecesRepaintQueued) return;
    piecesRepaintQueued = true;
    requestAnimationFrame(() => {
      piecesRepaintQueued = false;
      if (game) render();
    });
  }

  function loadPieceImages() {
    const base = new URL('img/chess/', document.baseURI).href;
    for (const color of ['w', 'b']) {
      for (const type of ['k', 'q', 'r', 'b', 'n', 'p']) {
        const key = color + type.toUpperCase();
        const img = new Image();
        img.addEventListener('load', onPieceImageReady, { once: true });
        img.addEventListener('error', () => {
          console.warn('[chess] 棋子图片缺失，回退到字符棋子:', key);
        }, { once: true });
        img.src = base + key + '.svg';
        pieceImages.set(key, img);
      }
    }
  }

  function parseSquare(sq) {
    return { file: FILES.indexOf(sq[0]), rank: +sq[1] - 1 };
  }

  /* ============================================================
   * 交互
   * ============================================================ */
  function eventToSquare(e) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return null;
    const x = (e.clientX - rect.left) / rect.width * CANVAS_SIZE;
    const y = (e.clientY - rect.top) / rect.height * CANVAS_SIZE;
    // 用「格子中心」判定：cellX/cellY 返回的是格子左上角，
    // 之前直接拿来当中心用，导致每格只有左半边可点、最右一整列点不到。
    const col = Math.floor((x - MARGIN) / CELL);
    const row = Math.floor((y - MARGIN) / CELL);
    if (col < 0 || col >= SQ || row < 0 || row >= SQ) return null;
    const cx = cellX(col) + CELL / 2;
    const cy = cellY(row) + CELL / 2;
    // 允许半个格子的容差，既好点又不会误吞到相邻格
    if (Math.abs(x - cx) > CELL / 2 || Math.abs(y - cy) > CELL / 2) return null;
    const s = screenToSquare(col, row);
    return sqName(s.file, s.rank);
  }

  function handleClick(e) {
    if (gameOver || thinking) return;
    if (game.turn() !== playerColor) return;

    const sq = eventToSquare(e);
    if (!sq) return;

    // 第二次点击：尝试走子
    if (selected) {
      const hits = legalTargets.filter(t => t.to === sq);
      if (hits.length) {
        const promos = [...new Set(hits.map(t => t.promotion).filter(Boolean))];
        if (promos.length > 1) {
          // 兵到底线：同一落点有多个升变选择，交给选择器
          openPromotion(selected, sq);
          return;
        }
        applyPlayerMove(selected, sq, promos[0] || hits[0].promotion);
        return;
      }
    }

    const piece = game.get(sq);
    if (piece && piece.color === playerColor) {
      selectSquare(sq);
    } else {
      selected = null;
      legalTargets = [];
      render();
    }
  }

  function selectSquare(sq) {
    selected = sq;
    legalTargets = game
      .moves({ square: sq, verbose: true })
      .map(m => ({ to: m.to, capture: !!m.captured, promotion: m.promotion }));
    render();
  }

  function clearSelection() {
    selected = null;
    legalTargets = [];
    closePromotion();
  }

  /* ---------------- 升变选择器 ---------------- */
  const PROMO_PIECES = [
    { key: 'q', glyph: '♛' },
    { key: 'r', glyph: '♜' },
    { key: 'b', glyph: '♝' },
    { key: 'n', glyph: '♞' },
  ];

  function openPromotion(from, to) {
    pendingPromotion = { from, to };
    const box = $('chessPromotion');
    if (!box) {
      // 没有选择器 UI 时退化为直接升后（与原行为一致）
      applyPlayerMove(from, to, 'q');
      return;
    }
    box.innerHTML = '<span class="chess-promotion-label">升变为</span>'
      + PROMO_PIECES.map(p =>
        `<button type="button" class="chess-promotion-btn" data-promo="${p.key}">${p.glyph}</button>`
      ).join('');
    box.classList.add('open');
  }

  function closePromotion() {
    pendingPromotion = null;
    const box = $('chessPromotion');
    if (box) {
      box.classList.remove('open');
      box.innerHTML = '';
    }
  }

  function applyPlayerMove(from, to, promotion) {
    // 只有升变才带 promotion，避免给普通走子塞一个无意义的 'q'
    const args = { from, to };
    if (promotion) args.promotion = promotion;
    let move = null;
    try {
      move = game.move(args);
    } catch (e) {
      console.error('[chess] 非法走子被引擎拒绝:', e.message, args);
      clearSelection();
      render();
      return;
    }
    if (!move) return;
    pushHistory(move);
    afterMove();
  }

  function pushHistory(m) {
    history.push({
      san: m.san, lan: m.lan, from: m.from, to: m.to,
      color: m.color, piece: m.piece, captured: m.captured || null,
    });
    lastMove = { from: m.from, to: m.to };
  }

  /** 走完一步后的公共处理：清选中、判终局、触发 AI */
  function afterMove() {
    clearSelection();
    updateMoveCount();
    updateLastMoveText();
    renderHistoryList();
    render();

    const st = game.isGameOver();
    if (st) {
      gameOver = true;
      thinking = false;
      finishGame();
      return;
    }
    if (game.turn() === playerColor) {
      updateStatus();
      updateControls();
      return;
    }
    // 轮到 AI
    thinking = true;
    updateStatus();
    updateControls();
    askEngine();
  }

  function finishGame() {
    let text;
    if (game.isCheckmate()) {
      const winner = game.turn() === 'w' ? '黑方' : '白方';
      text = winner + '将死，你输了';
      if ((game.turn() === 'w' ? 'b' : 'w') === playerColor) {
        scores[playerColor]++;
        text = '将死！你赢了';
      }
      saveScores();
      updateScoreUI();
    } else if (game.isStalemate()) {
      text = '逼和 · 和棋';
      scores.d++;
      saveScores();
      updateScoreUI();
    } else if (game.isThreefoldRepetition()) {
      text = '三次重复局面 · 和棋';
      scores.d++;
      saveScores();
      updateScoreUI();
    } else if (game.isInsufficientMaterial()) {
      text = '子力不足 · 和棋';
      scores.d++;
      saveScores();
      updateScoreUI();
    } else if (game.isDrawByFiftyMoves()) {
      text = '50 回合规则 · 和棋';
      scores.d++;
      saveScores();
      updateScoreUI();
    } else {
      text = '对局结束';
    }
    setStatus(text, true);
    updateTurnDot();
    updateControls();
  }

  /* ============================================================
   * 引擎
   * ============================================================ */

  /** 当前预设对应的 Stockfish 搜索深度 */
  function currentDepth() {
    return DIFFICULTY[preset] || DIFFICULTY.normal;
  }

  /**
   * 探测 Stockfish 是否存在。
   *
   * 不能只靠 HEAD：不少静态服务器 / CDN / 企业网关对 HEAD 返回 405、501、
   * 403，文件明明在也会被误判成「未下载」（这正是之前「明明下载了模型却提示
   * 未检测到」的原因）。所以 HEAD 拿不准时退回 GET 复核。
   *
   * 探测失败时把真实原因打到控制台——否则用户只看到「缺少引擎」，
   * 无从判断是文件缺失、路径不对、file:// 协议还是被扩展拦截。
   */
  async function fileExists(path) {
    const url = new URL(path, document.baseURI).href;
    if (location.protocol === 'file:') {
      console.warn('[chess] 当前是 file:// 协议，fetch 与 WebAssembly 都会被浏览器拦截。'
        + ' 请用 python3 -m http.server 或 VS Code Live Server 打开。');
    }
    console.log('[chess] 探测引擎:', url);

    // 1) HEAD 快路径
    try {
      const head = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      console.log('[chess] HEAD ->', head.status, head.statusText);
      if (head.ok) return true;
      // 405/501/403 说明服务器不支持/禁止该方法，不能据此判定文件不存在
      if (head.status === 405 || head.status === 501 || head.status === 403) {
        console.log('[chess] HEAD 不可用，改用 GET 复核…');
        const get = await fetch(url, { method: 'GET', cache: 'no-store' });
        console.log('[chess] GET  ->', get.status);
        return get.ok;
      }
      console.warn('[chess] 引擎文件不存在或不可访问：HTTP', head.status);
      return false;
    } catch (headErr) {
      console.warn('[chess] HEAD 请求异常：', headErr.message);
    }

    // 2) HEAD 抛错（CORS / file:// / 断网）→ 再试 GET
    try {
      const get = await fetch(url, { method: 'GET', cache: 'no-store' });
      console.log('[chess] GET  ->', get.status);
      return get.ok;
    } catch (getErr) {
      console.error('[chess] 引擎探测失败。请检查：'
        + '1) 是否用 HTTP 打开（file:// 不行）'
        + '2) js/lib/stockfish.js 是否存在'
        + '3) 浏览器扩展是否拦截了请求。原因：', getErr.message);
      return false;
    }
  }

  /** 探测 Stockfish 是否存在，然后直接启动（唯一后端） */
  async function setupEngine() {
    const hasJs = await fileExists(ENGINE_JS);
    // wasm 必须在位，否则引擎脚本能加载却没有二进制可实例化。
    // 只查 js 会漏掉「js 在、wasm 缺」这种半装状态。
    const hasWasm = hasJs ? await fileExists(ENGINE_WASM) : false;
    console.log('[chess] 引擎文件：js=' + hasJs + ' wasm=' + hasWasm);

    if (hasJs && hasWasm) {
      // 注意：这里**不能**直接写「已加载」。worker 只是被创建了，
      // 真正握手成功（收到 ready）之后才算加载完成，否则引擎起不来时
      // 侧栏会一直谎报「已加载」而实际上 AI 永远不动。
      showEngineBadge('正在加载 Stockfish…', true);
      setEngineMissingHint(false);
      spawnEngine();
    } else {
      // 没有 Stockfish 就没法对弈——简易引擎已删除。
      showEngineBadge('未安装 Stockfish · 无法对弈', true);
      setEngineMissingHint(true);
      setStatus('缺少 Stockfish 引擎，下方可下载后重试', true);
    }
    updateDepthHint();
  }

  /** 未安装引擎时给出下载指引（而不是只说一句「未检测到」） */
  function setEngineMissingHint(show) {
    const box = $('chessEngineHelp');
    if (box) box.classList.toggle('hidden', !show);
  }

  /** 启动 Stockfish 线程 */
  function spawnEngine() {
    if (worker) {
      try { worker.terminate(); } catch (e) { /* 已退出 */ }
      worker = null;
    }
    // 经典 worker：Stockfish 的 Emscripten 构建依赖 importScripts
    worker = new Worker('js/chess-worker.js');
    worker.onmessage = handleEngineMessage;
    worker.onerror = (e) => {
      console.error('[chess] 引擎线程出错:', e.message || e);
      engineReady = false;
      renderBadge();
      showEngineBadge('Stockfish 启动失败', true);
      // 文件存在才会走到这里，所以不弹下载面板
      setEngineMissingHint(false);
      setStatus('Stockfish 线程启动失败——请用 HTTP 打开并强刷（Ctrl+Shift+R）', true);
      thinking = false;
      setEngineThinking(false);
      updateControls();
    };
    worker.postMessage({ type: 'boot' });
    initEngineState();
  }

  function initEngineState() {
    engineReady = false;
    renderBadge();
    if (worker) worker.postMessage({ type: 'init', data: { gen, fen: game.fen() } });
  }

  function askEngine() {
    if (!worker) return;
    worker.postMessage({
      type: 'go',
      data: {
        gen,
        fen: game.fen(),
        depth: currentDepth(),
        // 同时给 movetime：asm.js 版慢，movetime 保证引擎一定会交着法。
        // 它先到哪个就用哪个，depth 够浅时通常 movetime 先到。
        movetime: MOVE_TIME_MS[preset] || MOVE_TIME_MS.normal,
      },
    });
    setEngineThinking(true);
    armThinkWatchdog();
  }

  /**
   * 思考看门狗：引擎可能脚本加载成功却永远不回应（实测 Stockfish 会静默卡死），
   * 没有兜底的话界面会一直停在「AI 思考中…」，玩家彻底卡住。
   * 简易引擎已删除，所以这里只能报错交回控制权，不能再自动切换后端。
   */
  function armThinkWatchdog() {
    disarmThinkWatchdog();
    const startGen = gen;
    thinkTimer = setTimeout(() => {
      thinkTimer = null;
      if (startGen !== gen || !thinking) return;      // 已经换局 / 已经走完
      console.warn('[chess] 引擎思考超时');
      thinking = false;
      setEngineThinking(false);
      setStatus('引擎无响应，请点「新对局」重试', true);
      updateControls();
    }, 60000);
  }

  function disarmThinkWatchdog() {
    if (thinkTimer) { clearTimeout(thinkTimer); thinkTimer = null; }
  }

  function stopEngine() {
    if (worker) worker.postMessage({ type: 'stop' });
    thinking = false;
    setEngineThinking(false);
    disarmThinkWatchdog();
  }

  function handleEngineMessage(e) {
    const { type, data } = e.data || {};

    if (type === 'ready') {
      engineReady = true;
      // 握手成功此刻才成立。worker 被创建不等于引擎可用，
      // 之前无条件写死「已加载」会让引擎起不来时侧栏一直谎报。
      if (!badgeWarn) {
        showEngineBadge('已加载 · Stockfish', false);
      } else {
        renderBadge();
      }
      updateDepthHint();
      updateStatus();
      return;
    }
    if (type === 'unavailable') {
      // 引擎文件在，但引擎线程起不来（wasm 被拦截 / 时序问题 / 构建不对）。
      // 这时**不能**弹下载面板——文件明明在，再点下载也没用，
      // 反而会让用户以为文件没放好。改为提示换服务器 / 重试。
      engineReady = false;
      renderBadge();
      showEngineBadge('Stockfish 启动失败', true);
      setEngineMissingHint(false);
      setStatus('Stockfish 启动失败（' + ((data && data.reason) || '未知原因')
        + '）——请确认用 HTTP 打开并强刷', true);
      thinking = false;
      setEngineThinking(false);
      updateControls();
      return;
    }
    if (type === 'info') {
      if (data.gen !== gen) return;                 // 过期
      if (data.depth) setEngineInfo('深度 ' + data.depth + (data.score !== undefined ? ' · 评估 ' + formatScore(data) : ''));
      return;
    }
    if (type === 'bestmove') {
      if (data.gen !== gen) return;                 // 重开对局后的过期结果
      thinking = false;
      setEngineThinking(false);
      disarmThinkWatchdog();
      if (!data.move) {
        // 引擎没给着法。只有局面确实已经终局时才判负，
        // 否则（例如搜索被打断后收到 bestmove 0000）不能算作终局，
        // 更不能记进 localStorage 战绩。
        if (game.isGameOver()) {
          gameOver = true;
          render();
          finishGame();
        } else {
          thinking = false;
          setEngineThinking(false);
          setStatus('引擎未返回着法，请点「新对局」重开', true);
          updateControls();
        }
        return;
      }
      const from = data.move.slice(0, 2);
      const to = data.move.slice(2, 4);
      const promotion = data.move.length > 4 ? data.move[4] : '';
      const args = { from, to };
      if (promotion) args.promotion = promotion;
      let move = null;
      try {
        move = game.move(args);
      } catch (e) {
        // 引擎给了非法着法：不让它卡死对局，交回玩家
        console.error('[chess] 引擎着法非法:', e.message, args);
        thinking = false;
        setEngineThinking(false);
        setStatus('引擎着法异常，请点「新对局」重开', true);
        updateControls();
        return;
      }
      if (move) {
        pushHistory(move);
        afterMove();
      } else {
        thinking = false;
        setEngineThinking(false);
        setStatus('引擎着法异常，请点「新对局」重开', true);
        updateControls();
      }
      return;
    }
    if (type === 'error') {
      if (data.gen !== gen) return;
      thinking = false;
      setEngineThinking(false);
      setStatus('引擎出错：' + data.message, true);
    }
  }

  function formatScore(info) {
    if (info.mate !== undefined && info.mate !== null) {
      return info.mate > 0 ? 'M' + info.mate : '-M' + Math.abs(info.mate);
    }
    if (info.score === undefined) return '';
    // 两个后端都统一按「白方视角」上报（见 chess-worker.js 的 toWhiteScore），
    // 这里只做格式化，不再做符号翻转。
    const cp = info.score / 100;
    return (cp > 0 ? '+' : '') + cp.toFixed(2);
  }

  /* ============================================================
   * UI
   * ============================================================ */
  function setStatus(text, isError) {
    const el = $('chessStatusText');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('status-error', !!isError);
  }

  function updateStatus() {
    updateTurnDot();
    if (gameOver) return;
    if (thinking) {
      setStatus('AI 思考中…');
      return;
    }
    const turn = game.turn();
    setStatus(turn === 'w' ? '白方回合' : '黑方回合');
  }

  function setEngineThinking(on) {
    const el = $('chessThinkingIndicator');
    if (el) el.classList.toggle('visible', !!on);
  }

  function setEngineInfo(text) {
    const el = $('chessEngineInfo');
    if (el) el.textContent = text;
  }

  /** 记录徽标文案/告警态（真正上色交给 renderBadge，便于 ready 后重绘） */
  function showEngineBadge(text, warn) {
    badgeText = text;
    badgeWarn = !!warn;
    renderBadge();
  }

  /** 引擎就绪状态变化后重绘徽标：Stockfish 成功才显示绿色 */
  function renderBadge() {
    const el = $('chessEngineBadge');
    if (!el) return;
    el.textContent = badgeText;
    el.classList.toggle('warn', badgeWarn || !engineReady);
    el.classList.toggle('ok', !badgeWarn && engineReady);
  }

  /** 难度提示：只有 Stockfish 一套深度 */
  function updateDepthHint() {
    const el = $('chessDepthHint');
    if (!el) return;
    el.textContent = 'Stockfish 深度 ' + currentDepth();
  }

  /** 回合指示点：跟着当前行棋方变色 */
  function updateTurnDot() {
    const el = $('chessTurnDot');
    if (!el || !game) return;
    el.classList.toggle('black', game.turn() === 'b');
  }

  function updateMoveCount() {
    const el = $('chessMoveCount');
    if (el) el.textContent = Math.ceil(history.length / 2);
  }

  function updateLastMoveText() {
    const el = $('chessLastMove');
    if (!el) return;
    const last = history[history.length - 1];
    const prev = history[history.length - 2];
    if (prev) el.textContent = prev.san + ' ' + last.san;
    else el.textContent = last ? last.san : '—';
  }

  function updateControls() {
    const undo = $('chessUndoBtn');
    if (undo) {
      // AI 思考中不能悔棋，否则会与过期结果打架
      undo.disabled = thinking || history.length < 2;
    }
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
    const w = $('chessWhiteScore');
    const b = $('chessBlackScore');
    const d = $('chessDrawScore');
    if (w) w.textContent = scores.w;
    if (b) b.textContent = scores.b;
    if (d) d.textContent = scores.d;
  }

  /* ============================================================
   * 对局控制
   * ============================================================ */
  function newGame() {
    stopEngine();
    gen++;                        // 作废所有在途的引擎结果
    game = new Chess();
    history = [];
    lastMove = null;
    clearSelection();
    gameOver = false;
    thinking = false;
    playerColor = 'w';
    orientation = 'w';
    setEngineThinking(false);
    setEngineInfo('—');
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
    // 连撤两步：AI 的一步 + 玩家的一步
    for (let i = 0; i < 2 && history.length; i++) {
      game.undo();
      history.pop();
    }
    const last = history[history.length - 1];
    lastMove = last ? { from: last.from, to: last.to } : null;
    clearSelection();
    gameOver = false;
    setEngineInfo('—');
    updateMoveCount();
    updateLastMoveText();
    updateStatus();
    updateControls();
    render();
    initEngineState();
  }

  function flipBoard() {
    orientation = orientation === 'w' ? 'b' : 'w';
    buildBoardBackground();
    render();
  }

  /* ============================================================
   * 初始化
   * ============================================================ */
  function bindEvents() {
    canvas.addEventListener('click', handleClick);

    const restart = $('chessRestartBtn');
    if (restart) restart.addEventListener('click', newGame);

    const undo = $('chessUndoBtn');
    if (undo) undo.addEventListener('click', undoMoves);

    const flip = $('chessFlipBtn');
    if (flip) flip.addEventListener('click', flipBoard);

    const copy = $('chessCopyFenBtn');
    if (copy) {
      copy.addEventListener('click', async () => {
        const fen = game.fen();
        try {
          await navigator.clipboard.writeText(fen);
          copy.textContent = '已复制';
        } catch (e) {
          copy.textContent = '复制失败';
        }
        setTimeout(() => { copy.textContent = '复制 FEN'; }, 1200);
      });
    }

    // 难度：只记录预设名，实际深度由 currentDepth() 按后端取
    const group = $('chessDepthGroup');
    if (group) {
      group.addEventListener('click', (e) => {
        const btn = e.target.closest('.chess-diff-btn');
        if (!btn) return;
        group.querySelectorAll('.chess-diff-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        preset = btn.dataset.preset;
        updateDepthHint();
        // 正在思考时切难度：让新深度对下一手生效
        if (thinking) stopEngine();
      });
    }

    // 升变选择器
    const promo = $('chessPromotion');
    if (promo) {
      promo.addEventListener('click', (e) => {
        const btn = e.target.closest('.chess-promotion-btn');
        if (!btn || !pendingPromotion) return;
        const { from, to } = pendingPromotion;
        closePromotion();
        applyPlayerMove(from, to, btn.dataset.promo);
      });
    }

    // 下载链接统一用 ENGINE_URL，避免 HTML 与代码两处各写一份而走偏
    const dl = $('chessEngineDownload');
    if (dl) dl.href = ENGINE_URL;

    // 引擎：重新检测（用户刚放好 stockfish.js 后可点此刷新，不必重开页面）
    const retry = $('chessEngineRetry');
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

    // 侧栏：走子记录
    const toggle = $('chessHistoryToggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        const box = $('chessHistoryList');
        if (!box) return;
        box.classList.toggle('open');
        toggle.textContent = box.classList.contains('open') ? '收起走子记录 ▲' : '走子记录 ▼';
      });
    }
  }

  function renderHistoryList() {
    const box = $('chessHistoryList');
    if (!box) return;
    if (!box.classList.contains('open')) return;
    let html = '';
    for (let i = 0; i < history.length; i += 2) {
      const n = i / 2 + 1;
      const w = history[i] ? history[i].san : '';
      const b = history[i + 1] ? history[i + 1].san : '';
      html += '<div class="chess-history-row"><span class="num">' + n + '.</span>'
        + '<span class="w">' + w + '</span><span class="b">' + b + '</span></div>';
    }
    box.innerHTML = html || '<div class="chess-history-empty">还没有走子</div>';
  }

  function init() {
    if (initialized) return;
    initialized = true;

    canvas = $('chessCanvas');
    if (!canvas) return;
    canvas.width = CANVAS_SIZE * DPR;
    canvas.height = CANVAS_SIZE * DPR;
    ctx = canvas.getContext('2d');
    ctx.scale(DPR, DPR);

    loadScores();
    updateScoreUI();

    game = new Chess();
    loadPieceImages();
    buildBoardBackground();
    render();
    updateMoveCount();
    updateStatus();
    updateControls();

    bindEvents();
    setupEngine();
  }

  window.ChessApp = { init, newGame, undo: undoMoves, flip: flipBoard };

  // 等 bridge 把 Chess 挂上来再初始化；init 内部有 initialized 幂等保护
  whenChessReady((C) => {
    Chess = C;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  });
})();
