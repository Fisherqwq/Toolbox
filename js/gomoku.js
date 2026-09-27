(function () {
  'use strict';

  const BOARD_SIZE = 15;
  const CELL_SIZE = 40;
  const CANVAS_SIZE = BOARD_SIZE * CELL_SIZE;

  // 1 = 黑（玩家），-1 = 白（AI），0 = 空
  let board = [];
  let isPlayerTurn = true;
  let gameOver = false;
  let canvas, ctx;
  let worker = null;
  let aiThinking = false;

  // ---------- 初始化 ----------
  function init() {
    canvas = document.getElementById('gomokuCanvas');
    if (!canvas) return;
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;
    ctx = canvas.getContext('2d');

    document.getElementById('gomokuRestart').addEventListener('click', resetGame);
    canvas.addEventListener('click', handleClick);

    initWorker();
    resetGame();
  }

  function initWorker() {
    worker = new Worker('js/gomoku-worker.js', { type: 'module' });
    worker.onmessage = handleWorkerMessage;
    worker.onerror = (err) => {
      console.error('Worker error:', err);
      aiThinking = false;
    };
  }

  function handleWorkerMessage(e) {
    const { type, move, score, elapsed, ok, message } = e.data;

    if (type === 'error') {
      console.error('AI error:', message);
      aiThinking = false;
      updateStatus();
      return;
    }

    if (type === 'result') {
      aiThinking = false;
      if (!move) {
        // 没找到着法，随便下一个空位
        const fallback = findEmptyCell();
        if (fallback) {
          board[fallback.r][fallback.c] = -1;
          sendMoveToWorker(fallback.r, fallback.c, -1);
          drawBoard();
          if (checkWin(fallback.r, fallback.c, -1)) {
            gameOver = true;
            document.getElementById('gomokuStatus').textContent = 'AI 赢了！';
            return;
          }
        }
      } else {
        const [r, c] = move;
        board[r][c] = -1;
        drawBoard();
        if (checkWin(r, c, -1)) {
          gameOver = true;
          document.getElementById('gomokuStatus').textContent = 'AI 赢了！';
          return;
        }
      }
      if (isBoardFull()) {
        gameOver = true;
        document.getElementById('gomokuStatus').textContent = '平局';
        return;
      }
      isPlayerTurn = true;
      updateStatus();
    }
  }

  function sendMoveToWorker(i, j, role) {
    if (worker) worker.postMessage({ type: 'move', data: { i, j, role } });
  }

  function sendInitToWorker() {
    if (worker) worker.postMessage({
      type: 'init',
      data: { size: BOARD_SIZE, history: [] }
    });
  }

  // ---------- 游戏流程 ----------
  function resetGame() {
    board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(0));
    isPlayerTurn = true;
    gameOver = false;
    aiThinking = false;
    updateStatus();
    drawBoard();
    if (worker) {
      sendInitToWorker();
    } else {
      // 兜底：worker 还没建好，等它
      setTimeout(sendInitToWorker, 100);
    }
  }

  function updateStatus() {
    const el = document.getElementById('gomokuStatus');
    if (!el) return;
    if (gameOver) return;
    if (aiThinking) el.textContent = 'AI 思考中…';
    else if (isPlayerTurn) el.textContent = '你的回合 (黑棋)';
    else el.textContent = 'AI 回合 (白棋)';
  }

  function handleClick(e) {
    if (gameOver || !isPlayerTurn || aiThinking) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    const c = Math.round((x - CELL_SIZE / 2) / CELL_SIZE);
    const r = Math.round((y - CELL_SIZE / 2) / CELL_SIZE);

    if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) return;
    if (board[r][c] !== 0) return;

    // 玩家落子
    board[r][c] = 1;
    sendMoveToWorker(r, c, 1);
    drawBoard();

    if (checkWin(r, c, 1)) {
      gameOver = true;
      document.getElementById('gomokuStatus').textContent = '你赢了！🎉';
      return;
    }
    if (isBoardFull()) {
      gameOver = true;
      document.getElementById('gomokuStatus').textContent = '平局';
      return;
    }

    isPlayerTurn = false;
    aiThinking = true;
    updateStatus();

    // 请求 AI 思考
    worker.postMessage({
      type: 'think',
      data: { role: -1, depth: 4 }
    });
  }

  // ---------- 渲染 ----------
  function drawBoard() {
    ctx.fillStyle = '#e8c39e';
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    ctx.strokeStyle = '#8b5a2b';
    ctx.lineWidth = 1;
    for (let i = 0; i < BOARD_SIZE; i++) {
      ctx.beginPath();
      ctx.moveTo(CELL_SIZE / 2, CELL_SIZE / 2 + i * CELL_SIZE);
      ctx.lineTo(CANVAS_SIZE - CELL_SIZE / 2, CELL_SIZE / 2 + i * CELL_SIZE);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(CELL_SIZE / 2 + i * CELL_SIZE, CELL_SIZE / 2);
      ctx.lineTo(CELL_SIZE / 2 + i * CELL_SIZE, CANVAS_SIZE - CELL_SIZE / 2);
      ctx.stroke();
    }

    // 星位
    const starPoints = [3, 7, 11];
    ctx.fillStyle = '#8b5a2b';
    starPoints.forEach(r => {
      starPoints.forEach(c => {
        ctx.beginPath();
        ctx.arc(CELL_SIZE / 2 + c * CELL_SIZE, CELL_SIZE / 2 + r * CELL_SIZE, 4, 0, Math.PI * 2);
        ctx.fill();
      });
    });

    // 棋子
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (board[r][c] === 0) continue;
        const x = CELL_SIZE / 2 + c * CELL_SIZE;
        const y = CELL_SIZE / 2 + r * CELL_SIZE;
        ctx.beginPath();
        ctx.arc(x, y, CELL_SIZE / 2 - 4, 0, Math.PI * 2);
        if (board[r][c] === 1) {
          const grad = ctx.createRadialGradient(x - 5, y - 5, 5, x, y, CELL_SIZE / 2);
          grad.addColorStop(0, '#666');
          grad.addColorStop(1, '#000');
          ctx.fillStyle = grad;
        } else {
          const grad = ctx.createRadialGradient(x - 5, y - 5, 5, x, y, CELL_SIZE / 2);
          grad.addColorStop(0, '#fff');
          grad.addColorStop(1, '#ccc');
          ctx.fillStyle = grad;
        }
        ctx.fill();
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  // ---------- 工具 ----------
  function checkWin(r, c, player) {
    const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (const [dr, dc] of dirs) {
      let count = 1;
      for (let i = 1; i < 5; i++) {
        const nr = r + dr * i, nc = c + dc * i;
        if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE || board[nr][nc] !== player) break;
        count++;
      }
      for (let i = 1; i < 5; i++) {
        const nr = r - dr * i, nc = c - dc * i;
        if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE || board[nr][nc] !== player) break;
        count++;
      }
      if (count >= 5) return true;
    }
    return false;
  }

  function isBoardFull() {
    return board.every(row => row.every(cell => cell !== 0));
  }

  function findEmptyCell() {
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (board[r][c] === 0) return { r, c };
      }
    }
    return null;
  }

  window.Gomoku = { init, resetGame };
})();