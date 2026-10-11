# 第三方组件许可与署名（Third-Party Notices）

本项目自身代码以 **MIT** 许可发布，见 [LICENSE](LICENSE)。
但项目**打包分发**了若干第三方组件，它们各自的许可优先于 MIT —— 下面逐项列出，
并注明本项目的使用范围与必须完成的署名义务。

> 最后核对：2026-10-11。所有版本号、许可均来自组件自带的声明或上游官方文件，非推断。

---

## 一、必须遵守的三条硬约束

| # | 组件 | 许可 | 义务 |
| --- | --- | --- | --- |
| 1 | **Stockfish**（`js/lib/stockfish.js` + `.wasm`） | **GPLv3** | **强 copyleft**。对外分发（含放到公开网站/仓库）时，必须一并提供其**完整对应源码**。见 [第四节](#四stockfish--gplv3强-copyleft) |
| 2 | **cburnett 棋子图**（`img/chess/*.svg`） | **CC BY-SA 3.0** | 必须**署名** Cburnett，且**相同方式共享**（改编后仍用 CC BY-SA）。见 [第五节](#五棋子图--cc-by-sa-30) |
| 3 | **字体**（`vendor/fonts/*`） | **OFL-1.1** | 保留字体名与版权声明，**不得单独售卖字体**；本项目改名/子集化后需在下方逐项署名。见 [第三节](#三字体--sil-open-font-license-11) |

> ⚠ **第 1 条最容易被忽略**：GPLv3 的传染性只作用于 Stockfish 本身，
> 不会要求把本项目也改成 GPL（本项目只是"聚合"地调用它）。
> 但"提供源码"是硬性义务，不能只给 binary。
> **如果你不打算对外分发，只是自己本地用，这些义务都不触发。**

---

## 二、总览

| 组件 | 版本 | 许可 | 本项目中的文件 | 用法 |
| --- | --- | --- | --- | --- |
| 本项目代码 | — | MIT | 全部 `js/`、`css/`、`tools/`（除下列第三方文件） | 自有 |
| godogpaw | 源码 `main`（wasm 为本机编译，Go 1.27.1） | **MIT** | `js/lib/godogpaw/godogpaw.wasm`、`wasm_exec.js` | 中国象棋规则与 AI 引擎 |
| Go `wasm_exec.js` | go1.27.1 | **BSD-3-Clause** | `js/lib/godogpaw/wasm_exec.js` | Go 官方 WASM 胶水 |
| Stockfish.js | v19.0.0 `lite-single` | **GPLv3** | `js/lib/stockfish.js`、`stockfish.wasm` | 国际象棋 AI 引擎 |
| chess.js | v1.4.0 | **BSD-2-Clause** | `js/chess-engine/chess.js` + `.LICENSE` | 国际象棋规则 |
| cburnett 棋子 | — | **CC BY-SA 3.0** | `img/chess/{w,b}{K,Q,R,B,N,P}.svg` | 国际象棋棋子图 |
| Material Design Icons | mdi（Pictogrammers） | **Apache-2.0** | `vendor/icons/mdi-sprite.svg`（13 个图标） | 界面图标 |
| Instrument Serif | 2022 | **OFL-1.1** | `vendor/fonts/Instrument-Serif-*`（4 个 woff2） | 标题西文衬线 |
| Space Grotesk | 2020 | **OFL-1.1** | `vendor/fonts/Space-Grotesk-*`（12 个 woff2） | 正文无衬线 |
| JetBrains Mono | 2020 | **OFL-1.1** | `vendor/fonts/JetBrains-Mono-*`（12 个 woff2） | 数字/等宽 |
| Noto Serif SC | 2017–2023 Adobe | **OFL-1.1** | `vendor/fonts/NotoSerifSC-subset.woff2` | 中文标题衬线 |
| 配图 5 张 | — | **Unsplash License** | `img/home/*.webp` | 首页配图（**署名要求见第六节**） |
| Lichess chess-openings | — | **CC0-1.0** | `js/chess-book.js` | 开局库数据源 |
| 五子棋引擎（改编自 gobang） | — | 未声明 | `js/gomoku-engine/` | 五子棋 AI 算法（Alpha-Beta 剪枝） |

---

## 三、字体 —— SIL Open Font License 1.1

四套字体均在 **SIL Open Font License 1.1** 下发布（`licURL` 字段指向
<https://scripts.sil.org/OFL>，从各 woff2 的 `name` 表读出）。

| 字体 | 版权声明（字体文件内原样） | 上游 |
| --- | --- | --- |
| Instrument Serif | `Copyright 2022 The Instrument Serif Project Authors (https://github.com/Instrument/instrument-serif)` | <https://github.com/Instrument/instrument-serif> |
| Space Grotesk | `Copyright 2020 The Space Grotesk Project Authors (https://github.com/floriankarsten/space-grotesk)` | <https://github.com/floriankarsten/space-grotesk> |
| JetBrains Mono | `Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)` | <https://github.com/JetBrains/JetBrainsMono> |
| Noto Serif SC | `(c) 2017-2023 Adobe (http://www.adobe.com/)` | <https://github.com/notofonts/noto-cjk> |

**本项目的处理**：

- 通过 Google Fonts 的 woff2 分发（`tools/build-vendor-assets.mjs` 下载并**本地自托管**，
  不再运行时请求 Google 服务器）
- Noto Serif SC 用 `fontTools` **子集化**到 962 个字符（160 KB），
  并固定字重 600 —— 属于 OFL 允许的"修改/再分发"，不改变字体名称的含义
- **未**单独售卖字体，**未**用 Reserved Font Name 做衍生命名

OFL 全文：<https://openfontlicense.org/open-font-license-official-text/>

---

## 四、Stockfish —— GPLv3（强 copyleft）

| 项 | 值 |
| --- | --- |
| 组件 | Stockfish 19 Lite WASM（Chess.com, LLC 打包） |
| 版本 | v19.0.0，构建变体 `stockfish-19-lite-single` |
| 许可 | **GNU General Public License v3.0** |
| 本项目的文件 | `js/lib/stockfish.js`（21 KB）、`js/lib/stockfish.wasm`（1.7 MB） |
| 上游 | <https://github.com/nmrugg/stockfish.js> |
| 许可全文 | <https://github.com/nmrugg/stockfish.js/blob/master/Copying.txt> |
| Stockfish 本体 | <https://github.com/official-stockfish/Stockfish> |

### 分发时必须做的事

1. **提供完整对应源码**：把 Stockfish 官方源码（或 nmrugg/stockfish.js 对应 tag 的源码）
   与二进制一起提供，或在明显位置给出可获取的地址。
2. 保留版权与许可声明（`Copying.txt`）。
3. 若修改了 Stockfish 源码，修改部分同样以 GPLv3 发布。

### 本项目做了什么 / 没做什么

- **没有**修改 Stockfish 的源码或二进制，只是原样加载
- **没有**把 GPLv3 传染到本项目其余代码：本项目通过标准 Worker 消息与它通信，
  属于独立进程边界的聚合，不需要整体改 GPL
- ⚠ `js/lib/stockfish.wasm` 在 `.gitignore` 里（体积原因不入库），
  **对外分发时别漏了把它和源码链接一起给出去**

---

## 五、棋子图 —— CC BY-SA 3.0

| 项 | 值 |
| --- | --- |
| 作者 | **Cburnett** |
| 来源 | <https://commons.wikimedia.org/wiki/Category:SVG_chess_pieces> |
| 许可 | **Creative Commons Attribution-ShareAlike 3.0 Unported** |
| 全文 | <https://creativecommons.org/licenses/by-sa/3.0/> |
| 本项目文件 | `img/chess/wK.svg wQ wR wB wN wP bK bQ bR bB bN bP`（共 12 个） |

### 必须保留的署名

> Chess piece images by **Cburnett**, licensed under **CC BY-SA 3.0**,
> via Wikimedia Commons. Modifications: none (files used as-is).

**ShareAlike 的含义**：这些棋子图若被改编（改色、改形状、重新描线），
衍生图必须继续以 CC BY-SA 3.0（或兼容许可）发布 —— 但**只约束图本身**，
不会要求本项目的 JS/CSS 也跟着 CC BY-SA。

### 想省掉这条约束的办法

换成公共领域或许可更宽松的棋子集（例如
[lichess-org/lila 的 `public/piece`](https://github.com/lichess-org/lila/tree/master/public/piece)
里部分集合为 CC0），然后同步更新本节与 README 的许可表。

---

## 六、首页配图 —— Unsplash License

5 张配图原先通过 `picsum.photos/seed/<seed>` 取用，已本地化为 WebP。
它们的原始出处（用 Picsum 的 `/info` 接口逐个查到，非推测）：

| 本项目文件 | Picsum id | 作者 | 原始链接 |
| --- | --- | --- | --- |
| `img/home/chess-desk.webp` | 764 | **Skyler Smith** | <https://unsplash.com/photos/PT1152jFqd4> |
| `img/home/chess-board.webp` | 911 | **thomas shellberg** | <https://unsplash.com/photos/Ki0dpxd3LGc> |
| `img/home/gomoku-stone.webp` | 1045 | **Aleksandra Boguslawska** | <https://unsplash.com/photos/USOu_Ob9rxo> |
| `img/home/xiangqi-board.webp` | 218 | **Monika Majkowska** | <https://unsplash.com/photos/Nq8LdWC7HnM> |
| `img/home/padlock.webp` | 283 | **Wojtek Witkowski** | <https://unsplash.com/photos/GtxZbYMCiPY> |

**Unsplash License 要点**（<https://unsplash.com/license>）：

- 允许免费用于商业与非商业用途，**不强制**署名（但"署名是受欢迎的"）
- **不允许**把照片原样作为"照片素材/壁纸"再分发（competitor service）
- 不允许用照片中的人物/商标做背书

**本项目的处理**：作为网页配图使用，属于许可允许的范畴。
上面这张表就是完整署名，**建议保留**——如果将来要换图，
用 `node tools/localize-images.mjs` 改 `IMAGES` 数组里的 seed 重新下载，并同步更新本表。

> 若想完全摆脱这层许可顾虑，可以换成自己拍/自己画的图，或
> CC0 图库（如 <https://picsum.photos> 之外的 openverse CC0 结果），本文件相应删掉一节即可。

---

## 七、其余组件（宽松许可，只需保留声明）

| 组件 | 许可 | 说明 |
| --- | --- | --- |
| **godogpaw** | MIT，© 2019 Mingang.He `<dustgle@gmail.com>` | 中国象棋引擎。上游 <https://github.com/hmgle/godogpaw>。`中国象棋模型/参考项目/godogpaw/LICENSE` 有全文。本项目未改其源码，wasm 为本机编译 |
| **Go `wasm_exec.js`** | BSD-3-Clause，© The Go Authors | 随 Go 1.27.1 分发，文件头已含许可声明。**必须与 wasm 同版本**，不要手改 |
| **chess.js** | BSD-2-Clause，© 2025 Jeff Hlywa | 国际象棋规则。全文在 `js/chess-engine/chess.js.LICENSE` |
| **Material Design Icons** | Apache-2.0，© Pictogrammers | <https://github.com/Templarian/MaterialDesign/blob/master/LICENSE>。本项目只打包了其中 13 个图标（`vendor/icons/mdi-sprite.svg`） |
| **Lichess chess-openings** | CC0-1.0（公共领域） | 开局库数据源，`js/chess-book.js` 由 `tools/build-chess-book.mjs` 生成。CC0 无署名义务 |
| **gobang**（五子棋引擎上游） | **未声明**（仓库无 LICENSE 文件，见 [issue #57](https://github.com/lihongxun945/gobang/issues/57)） | 本项目 `js/gomoku-engine/` 的五子棋 AI 算法改编自 <https://github.com/lihongxun945/gobang>（作者 lihongxun945）。该仓库目前没有附带开源许可证，上游代码默认保留所有权利。**对外分发前建议联系作者确认授权，或自行替换为有明确许可的引擎。** |

### 只用于**构建**、不进分发产物的工具

| 工具 | 许可 | 用途 |
| --- | --- | --- |
| `fontTools` | MIT | `tools/subset-cjk-font.mjs` 里做中文字体子集化（只在生成 `vendor/fonts/` 时跑） |
| Puppeteer / `puppeteer-core` | Apache-2.0 | 仅测试用（`tools/test-xiangqi-browser.mjs`、`tools/smoke-all-pages.mjs`），**不在 `node_modules` 之外分发** |

---

## 八、对外分发检查清单

- [ ] 发布包里带上 `LICENSE`（MIT）与本文件
- [ ] Stockfish 源码可获取（链接或一并打包）—— **GPLv3 硬要求**
- [ ] `img/chess/*.svg` 保留 Cburnett 署名与 CC BY-SA 3.0 说明
- [ ] `vendor/fonts/*` 保留各字体的版权行（本文件第三节已列全）
- [ ] `img/home/*.webp` 的 5 位 Unsplash 作者署名保留
- [ ] `js/chess-engine/chess.js.LICENSE`、`中国象棋模型/参考项目/godogpaw/LICENSE` 随包保留
- [ ] 若改了棋子图 → 衍生图必须继续 CC BY-SA 3.0
- [ ] 若换了引擎 → 更新本文件第二节总览表
- [ ] 五子棋引擎改编自 `lihongxun945/gobang`，该仓库目前无开源许可证。对外分发前需联系作者确认授权，或替换为有明确许可的五子棋引擎
