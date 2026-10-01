/**
 * 生成 js/chess-book.js（国际象棋开局库）
 *
 *   node tools/build-chess-book.mjs
 *
 * 数据来源：lichess-org/chess-openings（CC0 1.0 Universal，公共领域）
 *   https://github.com/lichess-org/chess-openings
 *
 * 做法：把每条 ECO 主变的 SAN 序列用 chess.js 回放一遍，
 *       记录「局面 → 候选着法」。键取 FEN 前 4 段（棋盘/行棋方/王车易位/吃过路兵），
 *       值是空格分隔的 UCI 着法，同一局面保留最多 3 个高频着法。
 *
 * 故意不存开局名：同一局面常被多个 ECO 共用，贴名字会给出误导性结论。
 */

import fs from "fs";
import os from "os";
import path from "path";
import { Chess } from "../js/chess-engine/chess.js";

const MAX_PLY = 20;    // 10 个回合；实测 16→20 只多 11 KB，收益已饱和
const MAX_MOVES = 3;
const SRC = "https://raw.githubusercontent.com/lichess-org/chess-openings/master";
const OUT = "js/chess-book.js";
const CACHE = path.join(os.tmpdir(), "chess-openings-eco");

const key4 = (fen) => fen.split(" ").slice(0, 4).join(" ");

async function ensureSource() {
  fs.mkdirSync(CACHE, { recursive: true });
  for (const f of ["a", "b", "c", "d", "e"]) {
    const dest = path.join(CACHE, f + ".tsv");
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) continue;
    process.stdout.write("下载 " + f + ".tsv … ");
    const res = await fetch(SRC + "/" + f + ".tsv");
    if (!res.ok) throw new Error("下载失败 " + f + ".tsv: HTTP " + res.status);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    console.log("ok");
  }
}

function sanList(pgn) {
  let s = pgn;
  s = s.replace(/\([^)]*\)/g, " ");   // 变着
  s = s.replace(/\$\d+/g, " ");        // NAG
  s = s.replace(/[!?]+/g, " ");        // 注解（必须用字符类：/!?/ 会匹配空串）
  s = s.replace(/\d+\.(\.\.)?/g, " "); // 步号 1. / 1...
  s = s.replace(/\b(1-0|0-1|1\/2-1\/2|\*)\b/g, " "); // 结果
  return s.split(/\s+/).filter((t) => t && /^[a-hKQRBNO][a-h0-9x=XO]*[+#]?$/.test(t));
}

await ensureSource();

const moves = new Map();
let lines = 0, bad = 0;

for (const f of ["a", "b", "c", "d", "e"]) {
  const rows = fs.readFileSync(path.join(CACHE, f + ".tsv"), "utf8").split("\n").filter((l) => l.trim());
  for (let i = 1; i < rows.length; i++) {          // 第 0 行是表头
    const pgn = rows[i].split("\t")[2];
    if (!pgn) continue;
    lines++;
    const g = new Chess();
    const sans = sanList(pgn);
    for (let j = 0; j < sans.length && j < MAX_PLY; j++) {
      const k = key4(g.fen());
      let m;
      try { m = g.move(sans[j]); } catch (e) { bad++; break; }
      if (!m) { bad++; break; }
      let e = moves.get(k);
      if (!e) { e = { uci: [], w: [] }; moves.set(k, e); }
      const u = m.from + m.to + (m.promotion || "");
      const idx = e.uci.indexOf(u);
      if (idx === -1) { e.uci.push(u); e.w.push(1); } else e.w[idx]++;
    }
  }
}

const mv = {};
for (const [k, e] of moves) {
  mv[k] = e.uci.map((u, i) => [u, e.w[i]])
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_MOVES)
    .map((x) => x[0]).join(" ");
}

const out = [
  "/*",
  " * 国际象棋开局库 —— 自动生成，请勿手工编辑",
  " *",
  " * 数据来源：lichess-org/chess-openings（CC0 1.0 Universal，公共领域）",
  " * 生成命令：node tools/build-chess-book.mjs",
  " * 生成方式：回放每条 ECO 主变，用 chess.js 推出各局面的候选着法；",
  " *           同一局面保留最多 3 个高频着法，键为 FEN 前 4 段。",
  " * 规模：" + Object.keys(mv).length + " 个局面",
  " */",
  "window.ChessBook = {",
  "  moves: " + JSON.stringify(mv) + ",",
  "};",
  "",
].join("\n");

fs.writeFileSync(OUT, out, "utf8");
console.log("\nECO 行数 " + lines + " | 解析失败 " + bad);
console.log("局面 " + Object.keys(mv).length + " | 输出 " + (Buffer.byteLength(out, "utf8") / 1024).toFixed(0) + " KB");
console.log("已写入 " + OUT);
