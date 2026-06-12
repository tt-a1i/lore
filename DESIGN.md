# lore — Milestone 1 设计文档

> 给 Git 补上意图层：把 AI agent 的对话和它产出的 commit 关联起来。
> 人用它审代码（`lore why`），agent 用它继承项目记忆（MCP server）。
> 本里程碑只做地基：**transcript ↔ commit 匹配引擎，并在真实仓库上验证准确率**。
> 匹配准确率不达标，上层一切（图谱、why、MCP）都不成立。

## 愿景速览（里程碑状态，2026-06-12 全部完成）

1. ✅ M1：Claude Code parser + 匹配引擎 + 准确率报告（本文档）
2. ✅ M2：骨架图谱（GraphStore 适配器：JSON 默认 / Kuzu 实验）+ `lore why` + `lore history`
3. ✅ M3：语义层蒸馏（Decision/Constraint/RejectedApproach，双时间模型）+ `lore ask` + MCP server
4. ✅ M4：Codex / OpenCode parser；D3 图谱 viewer + 时间轴回放（`lore serve`）
5. Next：存储与 git-ai notes 标准兼容；脱敏后 refs 共享；embedding 检索后端；代码存活率加权

> Kuzu 后端注记：kuzu 0.11.3 Node 绑定的 NAPI 终结器在父对象销毁后 GC 时
> flaky SIGSEGV（已逐层规避：await close / UNWIND 批量 / 字面量注入消灭
> PreparedStatement），但无法在 JS 侧根治，故默认 JSON 后端（同接口同语义），
> `LORE_GRAPH_BACKEND=kuzu` 启用实验后端，`npm run test:kuzu` 独立进程跑行为测试。

## M1 模块划分

```
src/
  schema/events.ts    统一事件 schema + parser 契约（已定，勿改语义）
  parsers/claude-code.ts   jsonl → ParsedSession
  git/types.ts        git 侧数据模型（已定）
  git/history.ts      GitHistoryReader 实现（spawn git，零原生依赖）
  match/types.ts      匹配引擎契约（已定，算法说明在文件头注释）
  match/engine.ts     MatchEngine 实现
  report/markdown.ts  RepoMatchReport → 人类可读 markdown
  cli.ts              lore scan / lore sample
```

## CLI（M1 范围）

- `lore scan --repo <path>`：发现该仓库的所有 transcript → 解析 → 读 git 历史 →
  匹配 → 写 `.lore/report.json` + 终端摘要（匹配率、置信度分布、格式漂移计数）。
- `lore sample --repo <path> -n 20 [--tier strong|weak]`：从 report 随机抽 n 个匹配，
  每个输出：commit subject + hunk 摘录 + 贡献该匹配的编辑事件前后最近的 user/assistant
  消息摘录（各 ≤300 字符）。这是给验证 agent / 人肉眼判断"归因是否正确"用的。

## 实现纪律

- 每个模块带 vitest 单测；parser 用 `fixtures/` 下的脱敏样本行测试。
- parser 绝不因单行解析失败抛弃整个文件；skipped 计数必须暴露。
- 性能基线：hive-private（55MB transcript，709 commits）全量 scan < 30s。
- 禁止把真实 transcript 内容提交进仓库（fixtures 必须手工构造或彻底脱敏）。

## 验证方法（M1 验收）

在 hive-private 上跑 `lore scan`：
1. 覆盖率：strong 匹配的 commit 占比（预期：agent 写的 commit 应大部分命中）。
2. 准确率：`lore sample -n 30` 的输出交给独立验证 agent 对抗审查
   （"这个 hunk 真的出自这段对话吗？"），按 strong/weak 分层统计。
3. 盲区分析：unmatchedCommits 里是什么（手写 commit？squash？格式漂移？）。

验收线：strong 层准确率 ≥ 90%，否则回炉匹配算法。

### M1 验收结果（2026-06-12）

两轮对抗验证（每轮 30 样本 × 独立 Sonnet 验证官，任务为推翻归因）：

- **第一轮：strong 50%（10/20）**。两个失败模式：
  ① 父 session 与 workflow 子 agent 共享 sessionId，桶合并导致证据指向错误文件（7例）；
  ② 单行 generic 内容碰巧重叠冲进 strong（3例）。
- 修复：归因粒度降到解析单元（MatchCandidate.sourcePath/matchedLines）；
  证据下限（<2 行丢弃，<3 行封顶 weak）。
- **第二轮：strong 100%（20/20）✅，weak 80%（8/10）**。weak 的 2 个错误均为
  预期残余（后续 session 编辑既有文件时与文件创建 commit 的重叠；2 行 CSS 碰巧）。

覆盖率（hive-private，transcript 窗口内 31 个 commit）：71% 匹配。
盲区全部可解释：Codex 写的 commit（M4 parser 范围）、merge commit（设计上不展开）、
云端 session（本地无 transcript）。

**M1 验收：通过。**
