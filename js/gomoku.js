(function () {
  'use strict';

  const BOARD_SIZE = 15;
  const CELL_SIZE = 40;
  const CANVAS_SIZE = BOARD_SIZE * CELL_SIZE;

  let canvas, ctx;
  let board = [];
  let isPlayerTurn = true;
  let gameOver = false;

  const SCORES = {
    FIVE: 100000,
    OPEN_FOUR: 10000,
    FOUR: 1000,
    OPEN_THREE: 1000,
    THREE: 100,
    OPEN_TWO: 100,
    TWO: 10,
    ONE: 1
  };

  function init() {
    canvas = document.getElementById('gomokuCanvas');
    if (!canvas) return;
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;
    ctx = canvas.getContext('2d');

    const restartBtn = document.getElementById('gomokuRestart');
    if (restartBtn && !restartBtn.dataset.bound) {
      restartBtn.addEventListener('click', resetGame);
      restartBtn.dataset.bound = '1';
    }

    if (!canvas.dataset.bound) {
      canvas.addEventListener('click', handleClick);
      canvas.dataset.bound = '1';
    }

    resetGame();
  }

  function resetGame() {
    board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(0));
    isPlayerTurn = true;
    gameOver = false;
    updateStatus();
    drawBoard();
  }

  function updateStatus() {
    const el = document.getElementById('gomokuStatus');
    if (!el) return;
    if (gameOver) return;
    el.textContent = isPlayerTurn ? '你的回合 (黑棋)' : 'AI 思考中…';
  }

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

    const starPoints = [3, 7, 11];
    ctx.fillStyle = '#8b5a2b';
    starPoints.forEach(r => {
      starPoints.forEach(c => {
        ctx.beginPath();
        ctx.arc(CELL_SIZE / 2 + c * CELL_SIZE, CELL_SIZE / 2 + r * CELL_SIZE, 4, 0, Math.PI * 2);
        ctx.fill();
      });
    });

    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (board[r][c] === 0) continue;
        const x = CELL_SIZE / 2 + c * CELL_SIZE;
        const y = CELL_SIZE / 2 + r * CELL_SIZE;
        ctx.beginPath();
        ctx.arc(x, y, CELL_SIZE / 2 - 4, 0, Math.PI * 2);
        const grad = ctx.createRadialGradient(x - 5, y - 5, 5, x, y, CELL_SIZE / 2);
        if (board[r][c] === 1) {
          grad.addColorStop(0, '#666');
          grad.addColorStop(1, '#000');
        } else {
          grad.addColorStop(0, '#fff');
          grad.addColorStop(1, '#ccc');
        }
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  function handleClick(e) {
    if (gameOver || !isPlayerTurn) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    const c = Math.round((x - CELL_SIZE / 2) / CELL_SIZE);
    const r = Math.round((y - CELL_SIZE / 2) / CELL_SIZE);

    if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) return;
    if (board[r][c] !== 0) return;

    board[r][c] = 1;
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
    updateStatus();

    setTimeout(() => {
      const move = getBestMove();
      if (move) {
        board[move.r][move.c] = 2;
        drawBoard();
        if (checkWin(move.r, move.c, 2)) {
          gameOver = true;
          document.getElementById('gomokuStatus').textContent = 'AI 赢了！';
          return;
        }
        if (isBoardFull()) {
          gameOver = true;
          document.getElementById('gomokuStatus').textContent = '平局';
          return;
        }
      }
      isPlayerTurn = true;
      updateStatus();
    }, 100);
  }

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

  function getBestMove() {
    let bestScore = -Infinity;
    let bestMove = null;

    const candidates = getCandidates();
    for (const { r, c } of candidates) {
      board[r][c] = 2;
      const score = minimax(2, false, -Infinity, Infinity);
      board[r][c] = 0;

      if (score > bestScore) {
        bestScore = score;
        bestMove = { r, c };
      }
    }
    return bestMove;
  }

  function getCandidates() {
    const candidates = [];
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (board[r][c] !== 0) continue;
        let hasNeighbor = false;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const nr = r + dr, nc = c + dc;
            if (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && board[nr][nc] !== 0) {
              hasNeighbor = true;
              break;
            }
          }
          if (hasNeighbor) break;
        }
        if (hasNeighbor) candidates.push({ r, c });
      }
    }
    if (candidates.length === 0) {
      const mid = Math.floor(BOARD_SIZE / 2);
      candidates.push({ r: mid, c: mid });
    }
    return candidates;
  }

  function minimax(depth, isMaximizing, alpha, beta) {
    const winner = evaluateBoard();
    if (winner !== 0 || depth === 0) return winner;

    const candidates = getCandidates();
    if (isMaximizing) {
      let maxEval = -Infinity;
      for (const { r, c } of candidates) {
        board[r][c] = 2;
        const evalScore = minimax(depth - 1, false, alpha, beta);
        board[r][c] = 0;
        maxEval = Math.max(maxEval, evalScore);
        alpha = Math.max(alpha, evalScore);
        if (beta <= alpha) break;
      }
      return maxEval;
    } else {
      let minEval = Infinity;
      for (const { r, c } of candidates) {
        board[r][c] = 1;
        const evalScore = minimax(depth - 1, true, alpha, beta);
        board[r][c] = 0;
        minEval = Math.min(minEval, evalScore);
        beta = Math.min(beta, evalScore);
        if (beta <= alpha) break;
      }
      return minEval;
    }
  }

  function evaluateBoard() {
    let score = 0;
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (board[r][c] === 2 && checkWin(r, c, 2)) return SCORES.FIVE;
        if (board[r][c] === 1 && checkWin(r, c, 1)) return -SCORES.FIVE;
      }
    }
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (board[r][c] === 2) score += evaluatePosition(r, c, 2);
        if (board[r][c] === 1) score -= evaluatePosition(r, c, 1);
      }
    }
    return score;
  }

  function evaluatePosition(r, c, player) {
    let total = 0;
    const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (const [dr, dc] of dirs) {
      let count = 1;
      let openEnds = 0;

      for (let i = 1; i < 5; i++) {
        const nr = r + dr * i, nc = c + dc * i;
        if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) break;
        if (board[nr][nc] === player) count++;
        else if (board[nr][nc] === 0) { openEnds++; break; }
        else break;
      }
      for (let i = 1; i < 5; i++) {
        const nr = r - dr * i, nc = c - dc * i;
        if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) break;
        if (board[nr][nc] === player) count++;
        else if (board[nr][nc] === 0) { openEnds++; break; }
        else break;
      }

      if (count >= 5) total += SCORES.FIVE;
      else if (count === 4 && openEnds >= 1) total += SCORES.FOUR;
      else if (count === 3 && openEnds >= 2) total += SCORES.THREE;
      else if (count === 2 && openEnds >= 2) total += SCORES.TWO;
      else if (count === 1 && openEnds >= 2) total += SCORES.ONE;
    }
    return total;
  }

  window.Gomoku = { init, resetGame };
})();