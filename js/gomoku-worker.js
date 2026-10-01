import Board from './gomoku-engine/board.js';
import { minmax } from './gomoku-engine/minmax.js';

let board = null;

self.onmessage = function (e) {
  const { type, data } = e.data;

  if (type === 'init') {
    board = new Board(data.size, 1);
    // 重放历史
    for (const move of data.history) {
      board.put(move.i, move.j, move.role);
    }
    self.postMessage({ type: 'ready' });
  }

  if (type === 'move') {
    if (!board) { self.postMessage({ type: 'error', message: 'board not initialized' }); return; }
    const ok = board.put(data.i, data.j, data.role);
    self.postMessage({ type: 'moved', ok });
  }

  if (type === 'think') {
    if (!board) { self.postMessage({ type: 'error', message: 'board not initialized' }); return; }
    const { role, depth, enableVCT, vctDepth, gen } = data;
    const start = performance.now();
    try {
      const [score, move, path] = minmax(board, role, depth, enableVCT !== false, vctDepth);
      const elapsed = performance.now() - start;
      // gen 原样带回，主线程用它丢弃「已经重开对局」的过期结果
      self.postMessage({ type: 'result', score, move, path, elapsed, gen });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message, gen });
    }
  }

  if (type === 'undo') {
    if (board) board.undo();
    self.postMessage({ type: 'undone' });
  }
};
