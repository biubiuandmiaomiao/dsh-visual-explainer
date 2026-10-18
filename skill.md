# 把一张图讲成小白能懂 + 可点的 mermaid 交互页

> 本手册配合本插件的工具使用：`visual_terms`（先解名词）、`visual_interactive`（出交互页 / 自检）。
> 触发场景：用户丢来一张图（时序图 / 流程图 / 架构图），要求翻译、解释、可视化、用 mermaid 画、做成可交互的。

---

## 0. 触发条件

满足任意两条就用本技能：

- 用户给了一张图，并说「翻译 / 解释 / 看不懂 / 讲人话 / 代码小白也能懂」；
- 用户要求「用 mermaid 画出来 / 可视化 / 画个图」；
- 用户要求「可交互 / 点着看 / 一步一步」；
- 用户给的是专业领域图（无障碍服务、RAG、CI、鉴权、消息队列……），读者明显不是行内人。

**不要**直接开画。先判断读者是谁：如果读者不懂图上的词，图就是装饰。

---

## 1. 为什么是这个顺序（三个真实失败模式）

| 失败模式 | 现象 | 解法 |
|---|---|---|
| 术语没解释 | 图画得很漂亮，读者卡在「节点树是什么」 | 第 0 轮 `visual_terms` |
| 一步到位的图 | 13 个箭头的图一次全给，读者不知道从哪看起 | 拆成 N 步，每步只画当前动作 |
| 画完没验证 | mermaid 断词、`alt` 框窄到读不了、图根本没渲染 | `visual_interactive action=check` + 逐张截图 |

---

## 2. 五轮流水线

### 第 0 轮：名词解码（`visual_terms`）

把图上会挡路的词逐个写成一句话大白话。规则：**不许用术语解释术语**；一个词最多两句。
没有名词要解释时也要写 `terms: []` + `note` 说明，别默默跳过。

### 第 1 轮：人话分层

四件套，缺一不可：

1. **一句话总览**：整张图在干什么，读者看完这一句就能走。
2. **角色表**：图上每个角色 = 生活里的谁。比喻要一致，别中途换。
   - 例：主线程 = 小助理；线程池 = 后厨；Overlay = 便利贴；系统事件 = 传令兵。
3. **按步骤讲**：第 1 步…第 N 步，每步先「谁做了什么」再「为什么这么做」。
4. **设计原则**：提炼 3~4 条「为什么这么设计」——这是读者真正想带走的东西。

### 第 2 轮：mermaid 中文版

| 原图表达的是 | 用哪种 |
|---|---|
| 一次交互里谁先谁后 | `sequenceDiagram` |
| 有分支/汇合的判定流程 | `flowchart` |
| 分层架构（多个分组） | `flowchart TD` + `subgraph` |

先给**极简版**（5~8 个节点讲通故事），再给**完整版**（保留全部分支）。
两版都落到文件里，也贴进回答（用户会复制去 mermaid.live）。

### 第 3 轮：交互页（`visual_interactive action=scaffold`）

```
visual_interactive  action=scaffold  dir=explain  title="看懂这个系统"  subtitle="一步一步"
```

写出 `explain/index.html` + 本地 `mermaid.min.js`（离线）。然后编辑 `const steps = [...]`，一步一个对象：

```js
{
  tag: '开场', scene: '开场', road: 'A',          // road 可选：A/B → 彩色路标
  title: '① 有人喊了一嗓子',
  plain: '大白话 2~3 句：先说谁做了什么，再说为什么。',
  eng: ['onAccessibilityEvent'],                  // 原图里的写法，用于对照
  hint: '<b>看这里：</b>…',                        // 可选，黄色提示条
  code: P + '\n    S->>M: 屏幕变了！'              // 注意 P 后面要先补 \n
}
```

**不要**试图用一份 mermaid 源码做「逐步显示」——`alt` 没闭合直接 parse 失败。
正确做法：**每一步一张独立小图** + 最后一张全景图。

### 第 4 轮：自检（`visual_interactive action=check`）

```
visual_interactive  action=check  dir=explain
→ 自检通过：14/14 张图渲染成功
```

没通过会指出 `step N`，改那一步的 `code` 再跑。通过后**再截图逐张看**：
「能渲染」不等于「好看」（断词、重叠、字被截都看不出来）。

### 第 5 轮：交付

回答里固定四块：

1. 一句话说明产物 + 两三张代表性截图（内嵌 PNG）；
2. mermaid 源码（至少极简版，最好两版）；
3. 怎么用（双击打开、键盘 `←` `→`、`#sN` 深链、`#selftest`）；
4. 文件清单 + 「已验证 N/N 渲染通过」（有证据再说这句）。

---

## 3. mermaid 硬规则与坑（都是踩过的）

### 3.1 中文标签会在窄泳道被强行断词

`抄成一份文字清单（节点树）` 会变两行并插一个 `-`，很难看。

- **修法**：`sequenceDiagram` 每条消息 **≤10 个汉字**；细节写进页面里的 `plain`。
- 全景图同理；`participant` 标签太长也会换行（见 3.6）。

### 3.2 `alt` 只跨一个泳道时，框会窄到无法阅读

分支里只有 `M->>M` 自调用时，`alt` 框只有一条泳道宽。

- **修法**：让分支里出现跨泳道元素，例如 `Note over M,O: 走「读」这条路`。

### 3.3 字符串拼 mermaid 代码最容易漏换行

```js
// ✗ P 末尾没有 \n，第一行会和最后一行 participant 粘在一起 → parse error
code: P + [ '    alt 有字', … ].join('\n    ')
// ✓ 先补一个 \n
code: P + '\n' + [ '    alt 有字', … ].join('\n    ')
```

判断依据：报错行号对不上你看到的行数，先怀疑拼接。

### 3.4 交互页里不要把「整图」当步骤

`alt` / `subgraph` 无法增量渲染，截断源码必然 parse 失败。

### 3.5 渲染竞态：快速点步骤会串图

`mermaid.render()` 是异步的，连续点击时旧结果可能后到：

```js
let renderToken = 0;
async function draw(code) {
  const my = ++renderToken;
  const { svg } = await mermaid.render('d' + my + '-' + Date.now(), code);
  if (my !== renderToken) return;   // 丢弃过期渲染
  box.innerHTML = svg;
}
```

### 3.6 全景图要换一套紧凑泳道

4 条泳道 × 默认间距会撑到 900px+，比容器宽，还会把 participant 标签挤到换行：
compact 配置 `{ actorMargin: 44, width: 172, height: 50, messageMargin: 30 }`。

### 3.7 离线：必须本地 mermaid + file://

`<script src="./mermaid.min.js">`，不要 CDN（断网白屏）。模板已带好，scaffold 会一起复制。

### 3.8 截图坑

- 加 `--hide-scrollbars`，否则右边多一条黑边；
- 加 `--virtual-time-budget=12000`，否则 mermaid 没渲染完就截；
- **Chrome 无头有时报 `Multiple targets are not supported in headless mode`**，DOM 为空 → 换 Edge；
  `visual_interactive check` 会自动逐个候选试。
- 自己写渲染页时容器要给固定宽度（如 `#box{width:1656px}`），否则 SVG 的 `width:100%` 会缩成一小团。

### 3.9 自检结果解析

页面源码本身就含 `'OK   step '` 这类字符串，dump 出来的 DOM 会把它们也算进去：
只取 `<pre id="selftest">…</pre>` 之间的文本，且正则必须要求后面跟数字（`/OK\s+step\s+(\d+)/`）。

---

## 4. 页面内置能力（scaffold 出来的模板）

| 交互 | 说明 |
|---|---|
| 左侧点步骤 | 右侧换图 + 换解释，当前步高亮并滚动跟随 |
| 上一步 / 下一步 / 自动播放 | 3 秒一步 |
| `←` `→` / `空格` | 键盘切换 / 播放暂停 |
| `#s4` | 深链，打开就停在第 4 步 |
| `#selftest` | 依次渲染全部图并输出结果（check 依赖它） |
| 源码折叠 | 每步 mermaid 源码，可复制去 mermaid.live |

要改的只有三处：`<header>` 标题、`const steps`、`const FULL`；逻辑（`go/draw/play/selftest`）不用动。

---

## 5. 交付前验收清单

- [ ] 第 0 轮名词解码写了（或明确说明没有名词）
- [ ] 一句话总览 + 角色表 + 分步 + 设计原则，四件套齐
- [ ] mermaid 每条消息 ≤10 汉字，没有断词
- [ ] 分支图（`alt`）宽度够，标签一行放得下
- [ ] `visual_interactive action=check` 报 N/N 通过
- [ ] 至少 2~3 张截图人工看过：无重叠、无空白、字没被截
- [ ] 回答里有：mermaid 源码 + 文件链接 + 怎么用 + 验证结论
- [ ] 没把「能渲染」当成「好看」，也没把没验证的东西说成已完成
