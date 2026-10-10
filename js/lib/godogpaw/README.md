# js/lib/godogpaw —— 中国象棋引擎（本地 WASM）

## 这是什么

| 文件 | 大小 | 说明 |
| --- | --- | --- |
| `godogpaw.wasm` | 4.7 MB | **godogpaw** 引擎本体，Go 1.27.1 编译的 WebAssembly |
| `wasm_exec.js` | 17 KB | Go 官方胶水（`$GOROOT/lib/wasm/wasm_exec.js`），**必须与编译 wasm 的 Go 版本一致** |
| `godogpaw-bridge.js` | 12 KB | 本项目写的桥接层：加载、就绪等待、超时、崩溃保护、输入校验 |

原始文件与源码仓库在仓库根的 `中国象棋模型/`（**原样保留，未改动**）：

- `中国象棋模型/main.wasm`、`中国象棋模型/wasm_exec.js` —— 与上面两个文件**逐字节相同**（SHA256 一致）
- `中国象棋模型/参考项目/godogpaw/` —— 引擎的完整 Go 源码仓库，含 `wasm/main.go`（桥接函数定义）
  和 `web/`（上游自带的参考 UI）

上游项目：[hmgle/godogpaw](https://github.com/hmgle/godogpaw)，UCCI 中国象棋引擎。
DEMO：https://hmgle.github.io/godogpaw/

> `main.wasm` 里嵌着编译期路径 `C:/Users/cystudent/Desktop/tmp/godogpaw/...`，说明它是本地编译产物。
> 引擎源码路径为 `godogpaw/engine/{bitboard,magic,search,movepicker,tt_js,yield_js}.go`。

## 它往 window 上挂的 6 个函数

这些是**实测**结果（`tools/test-xiangqi.mjs` 会逐条跑），不是从文档推断的：

| 函数 | 语义 |
| --- | --- |
| `engineNewGame(fen)` | 传 `''` = 标准开局。⚠ 传畸形 FEN 会**污染或打死**引擎，见下 |
| `engineGetBoard()` | 返回 JSON 字符串：`{ board[90], sideToMove, inCheck, isGameOver, lastMoveFrom, lastMoveTo }` |
| `engineGetLegalMovesFrom(sq)` | 返回目标格 JSON 数组。⚠ **只生成"轮到走子那一方"的着法**，问对方棋子一律返回 `[]`（这是设计，不是 bug） |
| `engineDoMoveBySquares(from, to)` | 合法 → `true` 并落子；非法 → `false` 且盘面不变 |
| `engineUndoMove()` | 撤一手，空历史 → `false` |
| `engineSearch(depth, ms)` | 返回 **Promise<string>**，着法形如 `"b2e2"`；⚠ **它自己就把棋走掉了**，调用方不要再补 `doMove` |

## 坐标系（三轮校准后确认）

```
sq = file + rank * 9
rank 0  = 红方底线（渲染时画在画布下方）   rank 9 = 黑方底线
码值：0 空 · 1..7 红（俥仕炮兵傌相帅）· 9..15 黑（车士砲卒马象将）
```

实测锚点：红帅 `sq4`、黑将 `sq85`、红车 `a0=0`、黑车 `a9=81`、红兵 `a3=27`（走 `a4=36`）、黑卒 `a6=54`（走 `a5=45`）。

## 性能（Node，开局局面）

| 深度 | 耗时 |
| --- | --- |
| 2 | 8 ms |
| 4 | 64 ms |
| 6 | 451 ms |
| 8 | 1548 ms |

`engineSearch(30, 800)` → 806 ms，说明**时间上限真的生效**（depth 与 ms 同时给时取先到者）。
搜索跑在**主线程**，靠 `runtime.Gosched()` 每约 8192 个结点让一次路，深搜时会看到界面卡顿；
引擎会往控制台打 `info score cp ... depth ... nodes ... pv ...`。

## ⚠ 引擎已知缺陷（不改引擎，只隔离并记录）

### 1. 畸形 FEN 会让引擎状态崩坏

```
engineNewGame('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR x - - 0 1')
```

- 一种结局：Go 侧 panic `index out of range [128] with length 90`（`engine.CheckersTo`），
  runtime 退出，之后所有调用抛 `Go program has already exited`
- 另一种结局：`engineNewGame` 静默"接受"，但行棋方被解析成 `1`，盘面与轮次不自洽

**两种都不能接受**。因此：

- `godogpaw-bridge.js` 做严格的 FEN 结构校验 + **白名单**，只允许标准开局
- 界面**不提供**自定义局面 / 粘贴 FEN / 复制局面功能
- 桥接层另有 `crashed` 状态兜底，万一发生就把页面切到"引擎已停止"，而不是静默假死

### 2. AI 可能走出"自己送将"的着法

自我对弈实测出现过：`1.b2e2 h9g7 2.a0a1 b7e7 3.a1d1 e7e3` —— 黑炮 e7→e3 之后，
红炮 e2 沿 e 线隔 e3 的炮打黑将 e9，等于黑方自己把将送出去。

引擎的合法性过滤**不保证**排除"走后自将"。前端**不做规则补丁**（按约定只记录复现步骤）。
若对局中出现明显违规着法，请记录：局面、着法序列、控制台里的 `info` 输出，交给引擎作者。

## 重新生成（换引擎时）

1. 用同一版本 Go 重新编译：`cd 中国象棋模型/参考项目/godogpaw && make wasm`
2. 把新 `godogpaw.wasm` 与同版本的 `wasm_exec.js` 覆盖到本目录
3. `node tools/test-xiangqi.mjs`（49 项）确认接口没变
4. `node tools/test-xiangqi-browser.mjs`（27 项）确认页面链路没变

**不要**手改 `wasm_exec.js`，也不要让它和 wasm 的 Go 版本错配 —— 错配时症状是启动即报
`Go version mismatch` 或 `importObject` 字段缺失。

## 许可

godogpaw 上游仓库为 MIT（见 `中国象棋模型/参考项目/godogpaw/LICENSE`）。
本项目只做加载与界面，不改引擎源码。
