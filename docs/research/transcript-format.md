# Claude Code transcript 格式（实测考古，v2.1.170，2026-06）

> 来源：对本机真实 transcript（55MB 语料）的抽样分析。parser 实现的唯一依据。
> ⚠️ 开源前需检查本目录文档不含隐私信息。

## 文件发现

- 项目目录：`~/.claude/projects/<path-with-slashes-replaced-by-dashes>/`
  （如 `/Users/x/code/foo` → `-Users-x-code-foo`）
- 主链 transcript：`<sessionUuid>.jsonl`（项目目录根下）
- subagent/sidechain：`<sessionUuid>/subagents/agent-*.jsonl` 及
  `<sessionUuid>/subagents/workflows/wf_*/agent-*.jsonl`（`isSidechain: true`，带 `agentId`）。
  **subagent 也会编辑文件，必须解析并归到父 session**（sessionId 相同）。
- `workflows/*/journal.jsonl` 不是对话，跳过。

## 行类型（每行一个 JSON 对象）

消费这些：

| type | 用途 | 关键字段 |
|---|---|---|
| `user` | 用户消息 或 tool_result 批次 | `message.content`（string 或 数组）、`toolUseResult`（见下）、`isMeta`、`timestamp`、`uuid`、`parentUuid` |
| `assistant` | 模型输出 | `message.content[]`（thinking/text/tool_use 块）、`message.stop_reason`、`timestamp` |

跳过这些：`system`（subtype: api_error/compact_boundary/stop_hook_summary/…）、`attachment`、
`ai-title`、`custom-title`、`last-prompt`、`mode`、`queue-operation`、`pr-link`（注意：这几个
session 元数据行**没有 uuid/timestamp**，不要试图入树）。

session 级元数据在每条 user/assistant 记录上都有：`sessionId`、`cwd`、`gitBranch`、`version`。

## 文件编辑的提取（核心）

Edit 的 tool_use（assistant 的 content 块）：
```json
{ "type": "tool_use", "id": "toolu_X", "name": "Edit",
  "input": { "file_path": "/abs", "old_string": "...", "new_string": "...", "replace_all": false } }
```
Write 的 input：`{ "file_path", "content" }`。MultiEdit/NotebookEdit 语料中零出现（shape 未确认，防御性处理）。

**对应结果在下一条 user 记录**，两条通道：
1. `message.content[]` 里的 `{ type: "tool_result", "tool_use_id": "toolu_X", "content", "is_error" }`
2. 同一条 user 记录顶层的 **`toolUseResult`**（结构化镜像，优先用它）：
```json
{ "type": "update",            // Write 是 "create"，Read 是 "text"
  "filePath": "/abs",
  "content": "<整个新文件内容>",
  "structuredPatch": [ { "oldStart": 2, "oldLines": 10, "newStart": 2, "newLines": 27,
                          "lines": ["+added", " ctx", "-removed"] } ],
  "originalFile": "<旧内容或 null>",
  "userModified": false }
```
`structuredPatch` 直接映射到我们的 `PatchHunk`；`userModified` 透传。

## git commit 锚点（Tier-0）

Bash 的 `toolUseResult` 可能带 `gitOperation`：
```json
{ "gitOperation": { "commit": { "sha": "81b52a8", "kind": "committed" } } }
{ "gitOperation": { "push": { "branch": "main" } } }
{ "gitOperation": { "pr": { "number": 16, "action": "ready" } } }
```
遇到 `commit.sha`（短 hash）发 `GitCommitEvent`。push/pr M1 忽略。

## 解析陷阱（全部来自实测）

1. **行可达几百 KB**（thinking/文件内容/base64 图片）。逐行流式读，无长度上限，
   单行 `JSON.parse` 失败时跳过并计入 skipped。
2. **流式增量**：多条 assistant 记录共享同一 `parentUuid`，是同一条消息的 streaming
   delta；取 `stop_reason != null` 的最后一条为最终态，避免把 tool_use 重复计数。
3. `isMeta: true` 的 user 记录是 harness 注入（图片提示、caveat、wakeup），不是真实用户
   意图——**user-message 事件要排除**，但其 `toolUseResult` 仍然有效（tool_result 批次
   记录有时带 isMeta 变体字段，以 toolUseResult 是否存在为准）。
4. compact 后：`isCompactSummary: true` 的 user 记录是注入的摘要，不算用户消息；
   `system.subtype=compact_boundary` 跳过即可，事件流不受影响。
5. `tool_result.content` 可能是 string 也可能是数组（MCP 工具，含 base64 image 块）——
   我们只从 `toolUseResult` 取数据，碰到数组形态直接忽略 content。
6. `usage.cache_creation` 新旧两种形态（flat / nested）——parser 不消费 usage，无关。
7. 时间戳：`timestamp` ISO-8601 带毫秒和 Z。ai-title 等元数据行没有该字段。

## 验证仓库画像要点（hive-private）

709 commits / 54 天；merge 仅 1.3%（rebase 主线）；agent trailer 仅 4.4%（不可作判定信号）；
平均 7 文件/commit 但右偏严重（最大 429 文件的 squash）；存在单日 107 commit 的密集日。
含义：时间窗只能当辅助信号，内容匹配是主信号，Tier-0 sha 锚点会因 rebase 部分失效。

## 其他 agent 数据源（M4 预研结论）

- **Codex CLI**：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`，事件型 jsonl
  （session_meta 带 cwd/cli_version；response_item 的 function_call 带 arguments）。
  文件编辑要从 exec_command/apply_patch 参数里解析。索引在 `~/.codex/session_index.jsonl`。
- **OpenCode**：`~/.local/share/opencode/opencode.db`（SQLite，event-sourcing 表结构），
  session/message 级齐全，file-edit 级需查 message part 表确认。
