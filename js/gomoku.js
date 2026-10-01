(function () {
  'use strict';

  // ============================================================
  // 常量
  // ============================================================
  const BOARD_SIZE = 15;
  const CELL = 40;
  const MARGIN = 34;                                       // 坐标标签边距
  const CANVAS_SIZE = MARGIN * 2 + CELL * (BOARD_SIZE - 1); // 620
  const STONE_R = CELL / 2 - 4;
  const ANIM_MS = 150;
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  const REDUCE_MOTION = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const COLORS = {
    grid: 'rgba(93, 58, 16, 0.6)',
    gridStrong: 'rgba(93, 58, 16, 0.9)',
    star: 'rgba(93, 58, 16, 0.9)',
    label: 'rgba(93, 58, 16, 0.78)',
    lastMove: '#f59e0b',
    winLine: 'rgba(245, 158, 11, 0.95)',
  };

  // ============================================================
  // 状态
  // ============================================================
  let board = [];          // 本地棋盘，仅用于渲染与落子判断
  let moveHistory = [];    // [{ r, c, role }]
  let isPlayerTurn = true; // 玩家执黑先行
  let gameOver = false;
  let winLine = null;      // 获胜的五连 [[r, c] ...]
  let lastMove = null;
  let hoverCell = null;
  let aiThinking = false;
  let animations = [];     // 落子动画队列
  let rafId = null;
  let gameGeneration = 0;  // 对局代数：重开对局后丢弃过期的 AI 结果

  let canvas, ctx, bgCanvas;
  let worker = null;
  let initialized = false;

  let difficulty = { depth: 4, vct: true, vctDepth: 8 };
  const scores = { player: 0, ai: 0 };
  const SCORE_KEY = 'gomoku-scores-v1';

  const $ = (id) => document.getElementById(id);
  const cellX = (c) => MARGIN + c * CELL;
  const cellY = (r) => MARGIN + r * CELL;

  // ============================================================
  // 棋盘背景：木质 + 网格 + 星位 + 坐标（离屏只绘制一次）
  // ============================================================
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

    // 木质底色
    const wood = g.createLinearGradient(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    wood.addColorStop(0, '#ddb877');
    wood.addColorStop(0.5, '#cfa355');
    wood.addColorStop(1, '#bf8f4a');
    g.fillStyle = wood;
    g.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // 木纹（固定种子，每次绘制一致）
    const rand = mulberry32(42);
    for (let i = 0; i < 80; i++) {
      const y = rand() * CANVAS_SIZE;
      const amp = 2 + rand() * 6;
      const alpha = 0.03 + rand() * 0.05;
      g.strokeStyle = 'rgba(110, 66, 18, ' + alpha.toFixed(3) + ')';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(-10, y);
      for (let x = 0; x <= CANVAS_SIZE + 10; x += 24) {
        g.lineTo(x, y + Math.sin(x * 0.02 + i * 1.7) * amp);
      }
      g.stroke();
    }

    // 左上柔和高光
    const sheen = g.createRadialGradient(
      CANVAS_SIZE * 0.3, CANVAS_SIZE * 0.18, 30,
      CANVAS_SIZE * 0.5, CANVAS_SIZE * 0.5, CANVAS_SIZE * 0.75
    );
    sheen.addColorStop(0, 'rgba(255, 255, 255, 0.10)');
    sheen.addColorStop(1, 'rgba(255, 255, 255, 0)');
    g.fillStyle = sheen;
    g.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // 网格
    g.strokeStyle = COLORS.grid;
    g.lineWidth = 1;
    for (let i = 0; i < BOARD_SIZE; i++) {
      const p = MARGIN + i * CELL;
      g.beginPath(); g.moveTo(MARGIN, p); g.lineTo(CANVAS_SIZE - MARGIN, p); g.stroke();
      g.beginPath(); g.moveTo(p, MARGIN); g.lineTo(p, CANVAS_SIZE - MARGIN); g.stroke();
    }

    // 外框略粗
    g.strokeStyle = COLORS.gridStrong;
    g.lineWidth = 2;
    g.strokeRect(MARGIN, MARGIN, CELL * (BOARD_SIZE - 1), CELL * (BOARD_SIZE - 1));

    // 星位
    g.fillStyle = COLORS.star;
    [3, 7, 11].forEach((r) => [3, 7, 11].forEach((c) => {
      g.beginPath();
      g.arc(cellX(c), cellY(r), 4, 0, Math.PI * 2);
      g.fill();
    }));

    // 坐标：列 A-O，行 15-1
    g.fillStyle = COLORS.label;
    g.font = '600 13px -apple-system, "Segoe UI", "PingFang SC", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let i = 0; i < BOARD_SIZE; i++) {
      const p = MARGIN + i * CELL;
      const letter = String.fromCharCode(65 + i);
      const num = String(BOARD_SIZE - i);
      g.fillText(letter, p, MARGIN / 2 + 1);
      g.fillText(letter, p, CANVAS_SIZE - MARGIN / 2);
      g.fillText(num, MARGIN / 2, p);
      g.fillText(num, CANVAS_SIZE - MARGIN / 2, p);
    }
  }

  // ============================================================
  // 渲染
  // ============================================================
  function drawStone(x, y, role, scale, alpha) {
    const r = STONE_R * scale;
    ctx.save();
    ctx.globalAlpha = alpha;

    // 投影
    ctx.beginPath();
    ctx.arc(x + 2, y + 3, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
    ctx.fill();

    // 主体
    const grad = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.12, x, y, r);
    if (role === 1) {
      grad.addColorStop(0, '#5f6772');
      grad.addColorStop(0.55, '#22262d');
      grad.addColorStop(1, '#04060a');
    } else {
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.55, '#e9ebee');
      grad.addColorStop(1, '#b3b9c0');
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    if (role === -1) {
      ctx.strokeStyle = 'rgba(110, 110, 110, 0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawWinLine() {
    if (!winLine || winLine.length < 2) return;
    const first = winLine[0];
    const last = winLine[winLine.length - 1];
    const x1 = cellX(first[1]), y1 = cellY(first[0]);
    const x2 = cellX(last[1]), y2 = cellY(last[0]);
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
    const E = 16; // 两端各延伸一点，更像“贯穿五连子”
    ctx.save();
    ctx.strokeStyle = COLORS.winLine;
    ctx.lineCap = 'round';
    ctx.shadowColor = COLORS.winLine;
    ctx.shadowBlur = 12;

    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(x1 - ux * E, y1 - uy * E);
    ctx.lineTo(x2 + ux * E, y2 + uy * E);
    ctx.stroke();

    ctx.lineWidth = 3;
    winLine.forEach(([r, c]) => {
      ctx.beginPath();
      ctx.arc(cellX(c), cellY(r), STONE_R + 3.5, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.restore();
  }

  function render(now) {
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    ctx.drawImage(bgCanvas, 0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // 棋子
    for (const m of moveHistory) {
      const x = cellX(m.c), y = cellY(m.r);
      const anim = animations.find((a) => a.r === m.r && a.c === m.c);
      let scale = 1, alpha = 1;
      if (anim) {
        const t = Math.min(1, (now - anim.start) / ANIM_MS);
        const e = 1 - (1 - t) * (1 - t); // easeOut
        scale = 1.4 - 0.4 * e;
        alpha = 0.5 + 0.5 * e;
      }
      drawStone(x, y, m.role, scale, alpha);
    }

    // 悬停预览
    if (hoverCell && !gameOver && isPlayerTurn && !aiThinking
        && board[hoverCell.r][hoverCell.c] === 0) {
      drawStone(cellX(hoverCell.c), cellY(hoverCell.r), 1, 1, 0.35);
    }

    // 最后一手标记
    if (lastMove && !winLine) {
      ctx.beginPath();
      ctx.arc(cellX(lastMove.c), cellY(lastMove.r), 4, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.lastMove;
      ctx.fill();
    }

    drawWinLine();
  }

  function requestRender() {
    if (rafId !== null) return;
    const tick = (now) => {
      rafId = null;
      animations = animations.filter((a) => now - a.start < ANIM_MS);
      render(now);
      if (animations.length > 0) rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  // ============================================================
  // 规则
  // ============================================================
  function getWinLine(r, c, player) {
    const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (const [dr, dc] of dirs) {
      const cells = [[r, c]];
      for (const sign of [1, -1]) {
        for (let i = 1; i < 5; i++) {
          const nr = r + sign * dr * i;
          const nc = c + sign * dc * i;
          if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE
              || board[nr][nc] !== player) break;
          if (sign === 1) cells.push([nr, nc]);
          else cells.unshift([nr, nc]);
        }
      }
      if (cells.length >= 5) return cells;
    }
    return null;
  }

  function isBoardFull() {
    return board.every((row) => row.every((cell) => cell !== 0));
  }

  function findEmptyCell() {
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (board[r][c] === 0) return { r, c };
      }
    }
    return null;
  }

  // ============================================================
  // 游戏流程
  // ============================================================
  function placeStone(r, c, role) {
    board[r][c] = role;
    moveHistory.push({ r, c, role });
    lastMove = { r, c };
    if (!REDUCE_MOTION) animations.push({ r, c, start: performance.now() });
    if (worker) {
      worker.postMessage({ type: 'move', data: { i: r, j: c, role } });
    }
    requestRender();
  }

  function finishCheck(role) {
    $('gomokuMoveCount').textContent = moveHistory.length;
    const line = getWinLine(lastMove.r, lastMove.c, role);
    if (line) {
      gameOver = true;
      winLine = line;
      $('gomokuTurnStone').className = 'stone-icon ' + (role === 1 ? 'black' : 'white');
      if (role === 1) {
        scores.player++;
        setStatus('你赢了！');
      } else {
        scores.ai++;
        setStatus('AI 获胜');
      }
      saveScores();
      updateScoreUI();
      updateControls();
      updateCursor();
      render(performance.now());
      return true;
    }
    if (isBoardFull()) {
      gameOver = true;
      setStatus('平局');
      updateControls();
      updateCursor();
      render(performance.now());
      return true;
    }
    return false;
  }

  function eventToCell(e) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = (e.clientX - rect.left) / rect.width * CANVAS_SIZE;
    const y = (e.clientY - rect.top) / rect.height * CANVAS_SIZE;
    const c = Math.round((x - MARGIN) / CELL);
    const r = Math.round((y - MARGIN) / CELL);
    if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) return null;
    // 离交叉点太远不响应，避免误触
    if (Math.abs(x - cellX(c)) > CELL * 0.46 || Math.abs(y - cellY(r)) > CELL * 0.46) return null;
    return { r, c };
  }

  function handleClick(e) {
    if (gameOver || !isPlayerTurn || aiThinking) return;
    const cell = eventToCell(e);
    if (!cell || board[cell.r][cell.c] !== 0) return;

    placeStone(cell.r, cell.c, 1);
    if (finishCheck(1)) return;

    isPlayerTurn = false;
    aiThinking = true;
    updateStatus();
    updateCursor();

    worker.postMessage({
      type: 'think',
      data: {
        role: -1,
        depth: difficulty.depth,
        enableVCT: difficulty.vct,
        vctDepth: difficulty.vctDepth,
        gen: gameGeneration,
      },
    });
  }

  function handleMouseMove(e) {
    const canHover = !gameOver && isPlayerTurn && !aiThinking;
    const cell = canHover ? eventToCell(e) : null;
    const next = (cell && board[cell.r][cell.c] === 0) ? cell : null;
    const changed = (next?.r !== hoverCell?.r) || (next?.c !== hoverCell?.c);
    hoverCell = next;
    if (changed) render(performance.now());
  }

  function undoMoves() {
    if (aiThinking || gameOver || moveHistory.length < 2) return;
    // 撤回 AI 与玩家的最后一手，回到玩家回合
    for (let k = 0; k < 2; k++) {
      const m = moveHistory.pop();
      if (!m) break;
      board[m.r][m.c] = 0;
      if (worker) worker.postMessage({ type: 'undo' });
    }
    const last = moveHistory[moveHistory.length - 1];
    lastMove = last ? { r: last.r, c: last.c } : null;
    isPlayerTurn = true;
    animations = [];
    updateStatus();
    updateCursor();
    render(performance.now());
  }

  function resetGame() {
    gameGeneration++;
    board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(0));
    moveHistory = [];
    isPlayerTurn = true;
    gameOver = false;
    winLine = null;
    lastMove = null;
    hoverCell = null;
    aiThinking = false;
    animations = [];
    if (worker) {
      worker.postMessage({ type: 'init', data: { size: BOARD_SIZE, history: [] } });
    }
    updateStatus();
    updateCursor();
    render(performance.now());
  }

  // ============================================================
  // Worker
  // ============================================================
  function handleWorkerMessage(e) {
    const { type, move, gen } = e.data;

    // 丢弃「对局已重开」的过期结果
    if (typeof gen === 'number' && gen !== gameGeneration) return;

    if (type === 'error') {
      console.error('AI error:', e.data.message);
      aiThinking = false;
      setStatus('AI 出错了：' + e.data.message, true);
      updateControls();
      return;
    }

    if (type !== 'result') return; // ready / moved / undone 静默确认

    aiThinking = false;

    if (move && board[move[0]] && board[move[0]][move[1]] === 0) {
      placeStone(move[0], move[1], -1);
    } else {
      // 兜底：引擎没给出合法着法时找一个空点
      const fb = findEmptyCell();
      if (fb) placeStone(fb.r, fb.c, -1);
    }

    if (finishCheck(-1)) return;
    if (isBoardFull()) return; // finishCheck 已处理平局

    isPlayerTurn = true;
    updateStatus();
    updateCursor();
  }

  // ============================================================
  // UI 状态
  // ============================================================
  function setStatus(text, isError) {
    const el = $('gomokuStatusText');
    el.textContent = text;
    el.classList.toggle('status-error', !!isError);
  }

  function updateStatus() {
    $('gomokuMoveCount').textContent = moveHistory.length;
    $('gomokuThinkingIndicator').classList.toggle('visible', aiThinking && !gameOver);
    $('gomokuTurnStone').className = 'stone-icon ' + (isPlayerTurn ? 'black' : 'white');
    if (gameOver) { updateControls(); return; } // 文案已由终局逻辑设置
    if (aiThinking) setStatus('AI 思考中');
    else if (isPlayerTurn) setStatus('你的回合 · 执黑');
    else setStatus('AI 回合');
    updateControls();
  }

  function updateControls() {
    $('gomokuUndoBtn').disabled = !(moveHistory.length >= 2 && !aiThinking && !gameOver);
  }

  function updateCursor() {
    canvas.classList.toggle('board-idle', gameOver || !isPlayerTurn || aiThinking);
  }

  function loadScores() {
    try {
      const s = JSON.parse(localStorage.getItem(SCORE_KEY) || '{}');
      scores.player = s.player || 0;
      scores.ai = s.ai || 0;
    } catch { /* 忽略损坏的存档 */ }
  }

  function saveScores() {
    try { localStorage.setItem(SCORE_KEY, JSON.stringify(scores)); } catch { /* 忽略 */ }
  }

  function updateScoreUI() {
    $('gomokuPlayerScore').textContent = scores.player;
    $('gomokuAiScore').textContent = scores.ai;
  }

  // ============================================================
  // 初始化（只执行一次）
  // ============================================================
  function init() {
    if (initialized) return;
    initialized = true;

    canvas = $('gomokuCanvas');
    if (!canvas) return;
    canvas.width = CANVAS_SIZE * DPR;
    canvas.height = CANVAS_SIZE * DPR;
    ctx = canvas.getContext('2d');
    ctx.scale(DPR, DPR);

    buildBoardBackground();

    canvas.addEventListener('click', handleClick);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseleave', () => {
      if (hoverCell) { hoverCell = null; render(performance.now()); }
    });

    $('gomokuRestartBtn').addEventListener('click', resetGame);
    $('gomokuUndoBtn').addEventListener('click', undoMoves);

    document.querySelectorAll('#gomokuDifficultyGroup .gomoku-diff-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#gomokuDifficultyGroup .gomoku-diff-btn')
          .forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        difficulty = {
          depth: +btn.dataset.depth,
          vct: btn.dataset.vct === '1',
          vctDepth: +btn.dataset.vctdepth || 8,
        };
        $('gomokuDiffHint').textContent = '搜索深度 ' + difficulty.depth + ' 层 · '
          + (difficulty.vct ? 'VCT 算杀 ' + difficulty.vctDepth + ' 层' : '无算杀');
      });
    });

    loadScores();
    updateScoreUI();

    worker = new Worker('js/gomoku-worker.js', { type: 'module' });
    worker.onmessage = handleWorkerMessage;
    worker.onerror = (err) => {
      console.error('AI 引擎加载失败:', err.message || err);
      aiThinking = false;
      gameOver = true;
      updateCursor();
      setStatus('AI 引擎加载失败——请通过 HTTP 服务访问页面（见 README）', true);
    };

    resetGame();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
