<div align="center">

# lore

**Git 的意图层** · 把 AI agent 的对话，关联到它写下的每一行代码

[![npm](https://img.shields.io/npm/v/@tt-a1i/lore?color=1f883d&label=npm)](https://www.npmjs.com/package/@tt-a1i/lore)
[![license](https://img.shields.io/badge/license-Apache--2.0-1f883d)](LICENSE)
[![tests](https://img.shields.io/badge/tests-542%20passing-1f883d)](#)

中文 · [English](README.en.md)

</div>

---

> **Git 记录了改了什么。lore 记录了为什么。**

代码正在变得廉价，**理解**没有。当 agent 写下大部分代码，真实的需求、半途发现的约束、被否决的方案——全都活在一段对话里，而那段对话在 session 结束时就蒸发了。三周后你盯着一行代码问"这为什么这么写"，没人答得上来，包括当时下指令的你。

lore 把这件事接住了。它扫描你机器上**已有的** agent 对话记录，把每个 commit 和产生它的对话自动关联起来——然后你可以对任何一行代码问 `why`：

```console
$ lore why src/server/upload-store.ts:42

commit: 1737b319  Add workspace upload evidence API
session: 13caa43d (2026-06-11, Claude Code)  ·  confidence 1.000 (strong)

  [USER]  可以，全部修复吧 …
  [AGENT] 开始编辑 workspace-upload-store.ts（异步 IO、两阶段删除、启动清扫、扩展名正则…）
```

这是真实输出。这行代码是哪次任务、谁下的指令、当时怎么决策的——**10 秒回到现场**。

---

## 为什么是 lore

lore **架在 Git 之上**，不替代 Git、不换编辑器、不要求全队迁移。数据全在本地 `.lore/` 目录，随仓库走，没有云、没有账号、没有 API key。

它服务两类用户，agent 才是主角：

| 给人 | 给 agent |
|---|---|
| `lore why <file>:<line>` —— 从任意一行代码，回溯到产生它的对话。审代码不再靠猜测意图。 | 一个 MCP server + 一套 hooks，让任何 agent 继承项目记忆：过去的决策、被否的方案、每个文件的约束。**新 session 不再冷启动。** |

### 装上第一分钟就有完整历史

别的工具从安装那天起记录；lore 直接挖你磁盘上**已经存在**的 transcript（Claude Code / Codex CLI / OpenCode）——你的"矿藏"早就在那了。装上即回溯索引全部历史。

---

## 快速开始

```bash
# 全局安装（命令名是 lore）
npm install -g @tt-a1i/lore

# 在你的仓库里一条龙：扫描 → 建图 → 打开 viewer
lore

# 或者按需调用
lore scan --repo .                       # 索引 transcript，跑匹配，建图谱
lore why src/app.ts:42                    # 这一行为什么存在？
lore ask "重试逻辑当时是怎么定的"          # 检索项目的决策库
lore status                              # 数据新鲜度、覆盖率、笔记概览
```

> 不想全局安装？用 `npx @tt-a1i/lore <command>` 即可。

---

## 它怎么工作

四步，从散落的 transcript 到可追问的图谱：

1. **捕获** —— 把 Claude Code、Codex CLI、OpenCode 的本地 transcript 解析为统一事件流。
2. **匹配** —— 三层引擎把 commit 归因到会话，处理 squash、worktree、rebase：
   - **T0** transcript 内 SHA 精确锚定
   - **T1** 编辑与 hunk 内容重叠（权重 0.8）
   - **T2** 按文件时间窗相关（权重 0.2）

   *证据下限*：少于 3 行重叠的匹配永远进不了 strong 层。
3. **图谱** —— 会话、commit、文件、决策进入嵌入式图存储；**双时间有效性**——被取代的决策标记失效，从不删除。
4. **蒸馏** —— 每会话一次 `claude -p` 调用，提取决策 / 约束 / 被否方案，逐条锚回原始对话消息。

---

## agent 的一天（这是 lore 真正的主场）

agent 最经典的事故：看到一段"奇怪"的代码自信地"修好"了——而那段代码是三周前为了绕某个坑特意写成那样的。lore 在两个层面阻止这件事：

**拉取（MCP）** —— 强 agent 主动查询。把 lore 接进任何 MCP host，agent 获得 5 个工具：

```jsonc
// claude_desktop_config.json
{
  "mcpServers": {
    "lore": { "command": "lore", "args": ["mcp", "--repo", "/path/to/your/repo"] }
  }
}
```

`lore_why` · `lore_ask` · `lore_history` · `lore_note`（agent 主动记录决定）· `lore_status`

**推送（hooks）** —— 弱 / headless agent 不会主动查询，那就把记忆**推**到它脸上：

```bash
lore hook install --repo .
```

一次装齐三个 Claude Code 钩子：

- **SessionStart** → `lore brief` 注入项目记忆简报（活跃约束 + 近期决策 + 数据新鲜度）
- **PreToolUse** → `lore guard` 在 agent 改某文件的瞬间，注入该文件挂着的约束（永不阻塞工具、任何异常静默退出）
- **Stop** → session 结束自动 `lore scan` 刷新索引，下个 session 永远是新鲜的

---

## 这玩意真的有用吗？（对照实验）

我们建了一个北极星 eval：一个可编译的 fixture 仓库，植入 6 条具体约束，6 个编码任务，每个任务的"自然解法"恰好踩中一条约束，任务措辞绝不暗示约束存在。同样的模型、同样的提示、盲评双判，唯一变量是 agent 能不能看到 lore。

| agent | 裸跑（违反约束） | MCP 拉取 | 钩子推送 |
|---|---|---|---|
| haiku（弱） | 3/6 (50%) | 2/6，**0 次调用工具** | **0/6 (0%)** 🏆 |
| sonnet（强） | 4/6 (67%) | **1/6**，6/6 调用工具 | — |

两个发现：**强 agent 配 MCP，约束违反从 4/6 降到 1/6**，且每次都真的查了 lore；**弱 agent 不会主动查询**（haiku 0/6 调用工具），但**钩子推送把它的违反率打到了 0**——甚至优于强 agent 的主动查询。

结论：**推送覆盖所有 agent，拉取服务强 agent 的深查。lore 两者都有。**

> 样本量小（n=6/臂），这是试点趋势不是定论。方法、fixture、判定全部公开在 [`eval/`](eval/)，一行复现：`npx tsx eval/run.mts`。

---

## 命令一览

| 命令 | 作用 |
|---|---|
| `lore` / `lore go` | 扫描 + 建图 + 打开 viewer，一条龙 |
| `lore scan` | 索引 transcript → 匹配 → 建图谱 |
| `lore why <file>:<line>` | 从一行代码回溯到产生它的对话 |
| `lore history <file>` | 文件的完整演化时间线，逐 commit 附归因 |
| `lore ask "<问题>" [--file <f>]` | 检索决策与对话；`--file` 查特定文件的约束 |
| `lore note` | 手动记录一条决策 / 约束 / 被否方案 |
| `lore status` | 数据新鲜度、覆盖率、笔记概览 |
| `lore distill` | LLM 蒸馏会话为语义笔记 |
| `lore mcp` | 启动 stdio MCP server（5 个记忆工具） |
| `lore brief` / `lore guard` | 推送式注入（供 hooks 调用） |
| `lore hook install` | 装上三件套钩子（推送 + 自动刷新） |
| `lore init` | 把 lore 指引注入 CLAUDE.md / AGENTS.md |
| `lore serve` | 本地图谱 viewer，四视图 + 时间轴回放 |

---

## Viewer —— 看见仓库的记忆

`lore serve` 在本地启动一个零构建、单页的 D3 viewer，四个视图共享一条时间轴：

- **Story** —— 叙事账本：会话分组下的归因 commit 流，绿轨标记出处，**点开任意 commit 直接读到当时的对话原文**
- **Graph** —— 力导向知识图谱，悬停高亮一度邻居
- **Map** —— 仓库 treemap，按 AI 归因覆盖度着色：灰为盲区，绿为完全可追溯
- **Decisions** —— 蒸馏笔记瀑布流，被取代的决策划线幽灵化并链到取代者

支持中英双语（跟随浏览器语言）、浅 / 深主题切换。

---

## 归因可信吗？（对抗验证）

在一个 726 commit 的生产仓库上，独立验证 agent 被明确指示去**推翻**每一条归因：

- **strong 层精度 100%**（20/20 全部成立；weak 层 80%）
- **覆盖率 71%**（transcript 保留窗口内；每个盲区都有解释——云端会话、merge、未落盘记录）
- **全量扫描 < 30s**（55MB transcript、709 commit 一次跑完）

而且 weak 归因（置信度 < 0.8）默认隐藏——**引导你读一段"可能是错的对话"，比不显示更糟**。方法与失败模式分析见 [DESIGN.md](DESIGN.md)。

---

## 路线图

- git-notes 互操作（兼容 git-ai 标准）
- 脱敏 + 团队共享（经 `refs/` 同步）
- embedding 检索（跨语言 ask）
- 代码存活率加权
- 推送臂的强 agent 验证 + 更大样本 eval

---

## 许可

[Apache-2.0](LICENSE) © 2026 lore contributors

<div align="center">
<sub>用 AI 写的代码，值得被 AI 记住。</sub>
</div>
