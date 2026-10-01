/**
 * chess.js 桥接
 *
 * 规则引擎 chess.js 是 ES module，而页面主体 js/chess.js 与 gomoku.js 一样
 * 是经典脚本（挂在 window 上、DOMContentLoaded 自初始化）。
 * 本文件负责把 ESM 的 Chess 类挂到 window，供经典脚本使用。
 *
 * 注意：ES module 脚本默认延迟执行，所以加载顺序是
 *   1. DOM 解析完成
 *   2. module 脚本（defer 语义）执行 → window.Chess 就绪
 *   3. DOMContentLoaded 触发 → chess.js 初始化
 * 由于 module 与 DOMContentLoaded 的时序不保证，这里额外做一次就绪检查。
 */
import { Chess } from './chess-engine/chess.js';

window.Chess = Chess;

// 通知经典脚本规则引擎已就绪（chess.js 内部有 initialized 幂等保护）
document.dispatchEvent(new CustomEvent('chess:ready'));
