# Codex CLI & OpenCode Data Format Research

**Investigation date:** 2026-06-12  
**Method:** Read-only sampling of real local data  
**Codex CLI version sampled:** 0.138.0-alpha.7, 0.139.0  
**OpenCode DB:** `~/.local/share/opencode/opencode.db` (1 session, sparse)

---

## 1. Codex CLI

### 1.1 File layout

```
~/.codex/
  session_index.jsonl          # lightweight index: one entry per thread
  sessions/YYYY/MM/DD/
    rollout-<ISO-ts>-<uuid>.jsonl   # full event stream for one thread
  version.json                 # {"latest_version": "0.139.0", ...}
```

**session_index.jsonl** — one JSON object per line:

```json
{
  "id": "019eb03e-2039-7991-9cb5-e6cc806b0bc9",
  "thread_name": "配置 gh",
  "updated_at": "2026-06-10T06:35:26.768712Z"
}
```

Fields: `id` (UUID v7), `thread_name` (plain text title), `updated_at` (ISO 8601 UTC).  
Total observed: 36 entries spanning 2026-06-10 to 2026-06-12.

**rollout filename pattern:**

```
rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl
```

Timestamp is the thread start time in local time (Asia/Shanghai observed). UUID is the same as `session_index.id`. A single thread can contain up to 24+ `session_meta` entries (multi-turn compaction; same UUID repeated each time context is rebuilt).

---

### 1.2 Record structure

Every line is a JSON object with three top-level keys:

```
{
  "timestamp": "<ISO 8601 UTC>",
  "type": "<record-type>",
  "payload": { ... }
}
```

**Record types observed:**

| type | count in sample | purpose |
|------|----------------|---------|
| `session_meta` | 1–24 per file | thread metadata (cwd, model, version) |
| `event_msg` | majority of lines | runtime events (user input, agent commentary, tool events) |
| `response_item` | majority of lines | LLM response stream items |
| `turn_context` | 1 per turn | per-turn environment snapshot |
| `compacted` | 0–2 per file | context compaction record |

---

### 1.3 `session_meta` — thread metadata

```json
{
  "timestamp": "2026-06-10T06:35:22.201Z",
  "type": "session_meta",
  "payload": {
    "id": "019eb03e-2039-7991-9cb5-e6cc806b0bc9",
    "timestamp": "2026-06-10T06:35:22.041Z",
    "cwd": "/Users/tushaokun/Documents/Codex/2026-06-10/gh",
    "originator": "Codex Desktop",
    "cli_version": "0.138.0-alpha.7",
    "source": "vscode",
    "thread_source": "user",
    "model_provider": "openai",
    "base_instructions": { "text": "..." }
  }
}
```

**Version difference — payload keys:**

| key | 0.138.0-alpha.7 | 0.139.0 |
|-----|----------------|---------|
| `id` | yes | yes |
| `cwd` | yes | yes |
| `originator` | yes | yes |
| `cli_version` | yes | yes |
| `source` | yes | yes |
| `thread_source` | yes | yes |
| `model_provider` | yes | yes |
| `base_instructions` | yes | yes |
| `forked_from_id` | yes | no |
| `parent_thread_id` | yes | no |
| `agent_nickname` | yes | no |
| `dynamic_tools` | yes | no |
| `multi_agent_version` | yes | no |

**Parser note:** `cwd` is the authoritative working directory for the entire thread. When `session_meta` appears multiple times (compaction), the cwd should be taken from the first occurrence.

---

### 1.4 `turn_context` — per-turn environment

```json
{
  "timestamp": "2026-06-10T06:35:24.089Z",
  "type": "turn_context",
  "payload": {
    "turn_id": "019eb03e-20d6-7590-bf3e-e00ee915e750",
    "cwd": "/Users/tushaokun/Documents/Codex/2026-06-10/gh",
    "workspace_roots": ["/Users/tushaokun/Documents/Codex/2026-06-10/gh"],
    "current_date": "2026-06-10",
    "timezone": "Asia/Shanghai",
    "approval_policy": "never",
    "sandbox_policy": { "type": "danger-full-access" },
    "permission_profile": { "type": "disabled" },
    "model": "gpt-5.5",
    "personality": "friendly",
    "collaboration_mode": { "mode": "default", "settings": { ... } },
    "multi_agent_version": "v1",
    "realtime_active": false,
    "effort": "medium",
    "summary": "auto"
  }
}
```

**Parser note:** `turn_id` links `turn_context` to `event_msg/task_started` and `event_msg/task_complete` entries via a matching `turn_id` field. Use this to group tool calls within a single user request.

---

### 1.5 `event_msg` — runtime events

`payload.type` subtypes observed:

| payload.type | meaning |
|-------------|---------|
| `task_started` | turn begins; fields: `turn_id`, `started_at` (unix sec), `model_context_window`, `collaboration_mode_kind` |
| `user_message` | **user text input**; fields: `client_id`, `message` (plain text), `images`, `local_images`, `text_elements` |
| `agent_message` | **assistant commentary** (not tool output); fields: `message` (plain text), `phase` (`"commentary"`), `memory_citation` |
| `token_count` | rolling token usage (no file-edit info) |
| `task_complete` | turn ends |
| `patch_apply_end` | **file edit result** — see §1.7 |
| `mcp_tool_call_end` | MCP tool invocation result; fields: `call_id`, `invocation` ({server, tool, arguments}), `duration`, `result` |
| `context_compacted` | context window was compacted |

**Example — user message:**
```json
{
  "timestamp": "2026-06-10T06:35:24.097Z",
  "type": "event_msg",
  "payload": {
    "type": "user_message",
    "client_id": "2ef695a9-8d5e-4cc6-aac0-e7aa725fdddc",
    "message": "帮我配置gh\n",
    "images": [],
    "local_images": [],
    "text_elements": []
  }
}
```

**Example — agent commentary:**
```json
{
  "timestamp": "2026-06-10T06:35:29.838Z",
  "type": "event_msg",
  "payload": {
    "type": "agent_message",
    "message": "我先看一下当前目录和 `gh` 的安装/登录状态。",
    "phase": "commentary",
    "memory_citation": null
  }
}
```

---

### 1.6 `response_item` — LLM stream items

`payload.type` subtypes observed:

| payload.type | meaning |
|-------------|---------|
| `message` | LLM message; `role` = `"developer"` / `"user"` / `"assistant"` |
| `function_call` | shell command or tool invocation |
| `function_call_output` | shell command result |
| `custom_tool_call` | **apply_patch** (file edit tool) |
| `custom_tool_call_output` | apply_patch result |
| `reasoning` | model chain-of-thought (not always present) |

**`message` role semantics:**
- `"developer"`: system-level instructions injected into context (permissions, app context)
- `"user"`: environment context envelope (`<environment_context>` XML with cwd/shell/date/filesystem)
- `"assistant"`: visible assistant text; `content[].type = "output_text"`, `payload.phase = "commentary"`

**Example — assistant message:**
```json
{
  "timestamp": "2026-06-10T06:35:29.838Z",
  "type": "response_item",
  "payload": {
    "type": "message",
    "role": "assistant",
    "content": [
      { "type": "output_text", "text": "我先看一下当前目录…" }
    ],
    "phase": "commentary"
  }
}
```

**Note on user text:** User text appears in `event_msg/user_message.payload.message`, NOT in `response_item/message`. The `response_item/message role=user` contains machine-injected context XML, not user prose.

---

### 1.7 `function_call` — shell commands (`exec_command`)

**The primary tool for all shell interaction, including git operations.**

```json
{
  "timestamp": "2026-06-10T06:35:29.838Z",
  "type": "response_item",
  "payload": {
    "type": "function_call",
    "name": "exec_command",
    "arguments": "{\"cmd\":\"pwd && git status --short --branch\",\"workdir\":\"/Users/tushaokun/Documents/Codex/2026-06-10/gh\",\"yield_time_ms\":1000,\"max_output_tokens\":2000}",
    "call_id": "call_pLqSvhP0EXly8Ggi0SIoVImc"
  }
}
```

**`arguments` field** is a JSON-encoded string (double-escaped). Parse with `JSON.parse(payload.arguments)`. Fields:

| field | type | meaning |
|-------|------|---------|
| `cmd` | string | shell command (bash/zsh) |
| `workdir` | string | working directory for this command |
| `yield_time_ms` | int | polling interval |
| `max_output_tokens` | int | output token cap |

**`function_call_output` format:**

```json
{
  "type": "response_item",
  "payload": {
    "type": "function_call_output",
    "call_id": "call_pLqSvhP0EXly8Ggi0SIoVImc",
    "output": "Chunk ID: b4f6ab\nWall time: 0.0000 seconds\nProcess exited with code 1\nOriginal token count: 97\nOutput:\n<stdout+stderr>\n"
  }
}
```

The `output` field is a plain string with a structured prefix. Parse pattern:

```
Chunk ID: <hex6>
Wall time: <float> seconds
Process exited with code <int>
Original token count: <int>
Output:
<actual stdout/stderr>
```

**Git commit extraction:** Codex does NOT auto-commit after file edits. Any `git commit` appears in `exec_command.cmd` and the resulting SHA appears in `function_call_output.output` after the `Output:` delimiter. Example expected output:

```
[main abc1234] commit message
 1 file changed, 10 insertions(+)
```

To extract SHA: match `\[(\w+)\s+([0-9a-f]{7,40})\]` in the output text after `Output:\n`.

**Other function call names observed:**

| name | namespace | meaning |
|------|-----------|---------|
| `exec_command` | — | shell command |
| `write_stdin` | — | write to stdin of a running process; args: `{session_id, chars, yield_time_ms, max_output_tokens}` |
| `update_plan` | — | update visible task plan; args: `{plan: [{step, status}]}` |
| `spawn_agent` | `multi_agent_v1` | spawn sub-agent; args: `{fork_context: bool, message: string}` |
| `wait_agent` | `multi_agent_v1` | wait for sub-agent result |
| `close_agent` | `multi_agent_v1` | close sub-agent |
| `fork_thread` | `codex_app` | fork thread into a new branch; args: `{environment: {type}}` |
| `js` | `node_repl` | run JavaScript in node REPL (MCP) |

---

### 1.8 `custom_tool_call` — file edits via `apply_patch`

**This is the canonical file-edit mechanism in Codex Desktop (not exec_command).**

```json
{
  "timestamp": "2026-06-11T02:40:48.154Z",
  "type": "response_item",
  "payload": {
    "type": "custom_tool_call",
    "status": "completed",
    "call_id": "call_rCFbhjT5GNthvwodWfLcGVAl",
    "name": "apply_patch",
    "input": "*** Begin Patch\n*** Add File: docs/leader_alignment_one_pager.md\n+line1\n+line2\n...\n*** End Patch"
  }
}
```

**Patch envelope syntax** (Codex proprietary format, NOT standard unified diff):

```
*** Begin Patch
*** Add File: <relative-or-absolute-path>
+<line content>
...
*** End Patch
```

```
*** Begin Patch
*** Delete File: <path>
*** Delete File: <path2>
*** End Patch
```

```
*** Begin Patch
*** Update File: <absolute-path>
@@
-<old line>
+<new line>
@@
-<old line>
+<new line>
*** End Patch
```

**Key differences from unified diff:**
- Hunk headers use bare `@@` without line number ranges
- File operation keywords: `Add File`, `Update File`, `Delete File`
- Outer envelope: `*** Begin Patch` / `*** End Patch`
- `input` is a plain string (not JSON-encoded)
- Absolute paths observed for `Update File`; relative paths observed for `Add File`

**Companion events around apply_patch:**

```
response_item/custom_tool_call (name=apply_patch, input=<patch>)
event_msg/patch_apply_end (call_id=<same>, stdout=<summary>, changes={<path>: {type, content/unified_diff}})
response_item/custom_tool_call_output (call_id=<same>, output="Exit code: 0\n...\n")
```

**`patch_apply_end` payload** (the most useful for parsing file edits):

```json
{
  "type": "patch_apply_end",
  "call_id": "call_rCFbhjT5GNthvwodWfLcGVAl",
  "turn_id": "019eb48c-1369-7990-8302-eac7d8304834",
  "stdout": "Success. Updated the following files:\nA docs/leader_alignment_one_pager.md\nA prompts/commitment_extraction_replay_prompt.md\n",
  "stderr": "",
  "success": true,
  "changes": {
    "/abs/path/to/docs/leader_alignment_one_pager.md": {
      "type": "add",
      "content": "<full file content>"
    },
    "/abs/path/to/file.html": {
      "type": "update",
      "unified_diff": "@@ -191,3 +191,3 @@\n \n-  old line\n+  new line\n..."
    },
    "/abs/path/to/old.md": {
      "type": "delete",
      "content": "<deleted file content>"
    }
  }
}
```

**`changes` value types:**

| type | fields |
|------|--------|
| `"add"` | `content` (full file text) |
| `"update"` | `unified_diff` (standard unified diff hunks, with line numbers) |
| `"delete"` | `content` (deleted file content) |

The `stdout` field uses git-style status prefixes: `A` = added, `M` = modified, `D` = deleted.

---

### 1.9 `compacted` — context compaction record

```json
{
  "timestamp": "2026-06-10T08:13:11.271Z",
  "type": "compacted",
  "payload": {
    "message": "",
    "replacement_history": [
      { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "..." }] },
      { "type": "compaction", "encrypted_content": "<fernet-encrypted-base64>" }
    ]
  }
}
```

The encrypted content is Fernet-encrypted (symmetric). The key is not stored in the rollout file. **Parser implication:** Earlier turns that were compacted are irretrievable from the JSONL alone; treat `compacted` as a hard boundary — only parse events after the last `compacted` entry for complete tool call coverage.

---

### 1.10 Git commit extraction — summary

Codex does **not** auto-run `git commit` after `apply_patch`. Git commits are explicit user-initiated actions run via `exec_command`. To extract them:

1. Filter `response_item` where `payload.type = "function_call"` AND `payload.name = "exec_command"`.
2. Parse `payload.arguments` as JSON; check `cmd` for `git commit`.
3. Find the matching `function_call_output` by `call_id`.
4. In `output`, extract text after `Output:\n`; match SHA pattern: `\[branch\s+([0-9a-f]{7,40})\]`.

**Caveat:** No `git commit` was found in the sampled sessions (2026-06-10 to 2026-06-12). These sessions used Codex Desktop for exploratory tasks, not code commits. The mechanism above is structurally confirmed but not observed in the sample.

---

## 2. OpenCode

### 2.1 File layout

```
~/.local/share/opencode/
  opencode.db         # SQLite main DB
  opencode.db-shm     # shared memory
  opencode.db-wal     # write-ahead log
  auth.json
  log/
  repos/
```

### 2.2 Table inventory

```sql
account              account_state        control_account
data_migration       event                event_sequence
message              migration            part
permission           project              project_directory
session              session_context_epoch session_input
session_message      session_share        todo
workspace
```

### 2.3 Key table schemas

**`session`**

| column | type | notes |
|--------|------|-------|
| `id` | text PK | prefix `ses_` + timestamp + random |
| `project_id` | text FK | references `project.id` |
| `slug` | text | human-readable slug (e.g. `"cosmic-planet"`) |
| `directory` | text | **cwd when session was created** |
| `title` | text | session title (auto-named or user-set) |
| `version` | text | `"local"` |
| `time_created` | integer | Unix ms |
| `time_updated` | integer | Unix ms |
| `model` | text | JSON: `{"id": "...", "providerID": "...", "variant": "..."}` |
| `cost` | real | cumulative cost |
| `tokens_input` | integer | cumulative |
| `tokens_output` | integer | cumulative |
| `summary_additions` | integer | lines added across session |
| `summary_deletions` | integer | lines deleted across session |
| `summary_files` | integer | files touched |
| `summary_diffs` | text | JSON array of diff summaries |
| `agent` | text | agent type |
| `workspace_id` | text FK | |
| `path` | text | git repo root (empty when not in a git repo) |
| `metadata` | text | JSON |

**Sample row:**
```
id:    ses_1504ac9fcffe18KIrryKhoS0PT
dir:   /
title: 问候
model: {"id":"mimo-v2.5-pro","providerID":"xiaomi-token-plan-cn","variant":"default"}
time_created: 1781064349187  (2026-06-10T04:05:49Z)
```

**`message`**

| column | type | notes |
|--------|------|-------|
| `id` | text PK | prefix `msg_` |
| `session_id` | text FK | |
| `time_created` | integer | Unix ms |
| `time_updated` | integer | Unix ms |
| `data` | text | **JSON blob — role-specific fields** |

`data` JSON for `role = "user"`:
```json
{
  "role": "user",
  "time": { "created": 1781064349256 },
  "agent": "build",
  "model": { "providerID": "...", "modelID": "..." },
  "summary": { "diffs": [] }
}
```

`data` JSON for `role = "assistant"`:
```json
{
  "parentID": "msg_...",
  "role": "assistant",
  "mode": "build",
  "agent": "build",
  "path": { "cwd": "/", "root": "/" },
  "cost": 0,
  "tokens": { "total": 8025, "input": 6980, "output": 11, "reasoning": 10, "cache": { "write": 0, "read": 1024 } },
  "modelID": "mimo-v2.5-pro",
  "providerID": "xiaomi-token-plan-cn",
  "time": { "created": 1781064349262, "completed": 1781064352798 },
  "finish": "stop"
}
```

**Note:** `message.data` does NOT contain text content. Text is in `part` table.

**`part`**

| column | type | notes |
|--------|------|-------|
| `id` | text PK | prefix `prt_` |
| `message_id` | text FK | |
| `session_id` | text FK | |
| `time_created` | integer | Unix ms |
| `time_updated` | integer | Unix ms |
| `data` | text | **JSON blob — typed content** |

`data` types observed in `part`:

| `data.type` | meaning | key fields |
|-------------|---------|-----------|
| `"text"` | user input or assistant output text | `text` |
| `"reasoning"` | chain-of-thought | `text`, `time.start`, `time.end` |
| `"step-start"` | turn boundary marker | — |
| `"step-finish"` | turn end + token summary | `reason`, `tokens`, `cost` |

**Sample parts for a "user says 你好, assistant says 你好！" exchange:**

```json
{"type": "text", "text": "你好"}                          // user part
{"type": "step-start"}                                    // assistant turn begins
{"type": "reasoning", "text": "...", "time": {...}}       // chain-of-thought
{"type": "text", "text": "你好！有什么可以帮你的吗？", "time": {...}}  // assistant text
{"type": "step-finish", "reason": "stop", "tokens": {...}, "cost": 0}
```

**Tool-call parts:** Not present in the single observed session (no tool-using session). Based on schema, tool calls would appear as additional `part.data.type` values (likely `"tool-call"` / `"tool-result"` or similar — not confirmed from real data).

**`event` table** — event sourcing log

| column | type | notes |
|--------|------|-------|
| `id` | text PK | prefix `evt_` |
| `aggregate_id` | text | session ID |
| `seq` | integer | monotonic within aggregate |
| `type` | text | event type string |
| `data` | text | JSON payload |

Event types observed:

| event type | meaning |
|-----------|---------|
| `session.created.1` | new session; `data.info` = full session object |
| `session.updated.1` | session state change; `data.info` = updated session |
| `session.next.agent.switched.1` | agent switch; `data.{timestamp, sessionID, messageID, agent}` |
| `session.next.model.switched.1` | model switch; `data.{timestamp, sessionID, messageID, model}` |
| `message.updated.1` | message state change; `data.info` = message object |
| `message.part.updated.1` | part created/updated; `data.part` = full part object, `data.time` |

The `event` table is the **authoritative source** — `session`, `message`, and `part` tables are read-model projections.

**`session_message`** — system/lifecycle messages (not user/assistant conversation):

| `type` | meaning |
|--------|---------|
| `"agent-switched"` | `data.{time, agent}` |
| `"model-switched"` | `data.{time, model}` |

**`todo`** — in-session todo list:

| column | type |
|--------|------|
| `session_id` | text |
| `content` | text |
| `status` | text |
| `priority` | text |
| `position` | integer |
| `time_created` / `time_updated` | integer Unix ms |

**`session_context_epoch`** — context compaction state (internal, not useful for parsing).

---

### 2.4 Recommended query patterns

**Get all messages with text for a session, in order:**

```sql
SELECT
  m.id AS message_id,
  json_extract(m.data, '$.role') AS role,
  json_extract(m.data, '$.time.created') AS time_ms,
  p.id AS part_id,
  json_extract(p.data, '$.type') AS part_type,
  json_extract(p.data, '$.text') AS text,
  json_extract(p.data, '$.time.start') AS reasoning_start,
  json_extract(p.data, '$.time.end') AS reasoning_end
FROM message m
JOIN part p ON p.message_id = m.id
WHERE m.session_id = '<session_id>'
  AND json_extract(p.data, '$.type') IN ('text', 'reasoning')
ORDER BY m.time_created, p.time_created;
```

**Get session list with cwd:**

```sql
SELECT id, directory, title, time_created, model,
       summary_files, summary_additions, summary_deletions
FROM session
ORDER BY time_created DESC;
```

**Get file edit summary for a session:**

```sql
SELECT summary_files, summary_additions, summary_deletions, summary_diffs
FROM session WHERE id = '<session_id>';
```

---

### 2.5 OpenCode data completeness — observed limitations

The local `opencode.db` contains only **1 session** ("你好" / "你好！") with no tool calls. The session `directory` was `/` (not a project directory). The `summary_diffs` column is empty. This means:

- **File-edit granularity is schema-confirmed but not data-confirmed.** The `summary_additions/deletions/files` fields exist and are populated with zeros for the observed session. Whether `summary_diffs` contains per-file diff data for code-editing sessions requires a session where actual edits occurred.
- **Tool-call `part` types are not confirmed.** The `part.data.type` taxonomy for tool calls (e.g., `"tool-call"`, `"tool-result"`, `"file-edit"`) is unconfirmed from real data.
- **Path/cwd for tool calls:** The assistant `message.data.path.cwd` field is available but showed `/` in the single observed session.

---

## 3. Parsing implementation guide

### 3.1 Codex parser

```typescript
interface CodexLine {
  timestamp: string;   // ISO 8601 UTC
  type: 'session_meta' | 'event_msg' | 'response_item' | 'turn_context' | 'compacted';
  payload: unknown;
}

// Extraction priority for user messages:
// event_msg.payload.type === 'user_message' -> payload.message (string)

// Extraction priority for assistant text:
// event_msg.payload.type === 'agent_message' -> payload.message (string)
// OR response_item.payload.type === 'message' && payload.role === 'assistant'
//   -> payload.content[].text (join output_text items)

// File edits (PRIMARY PATH):
// event_msg.payload.type === 'patch_apply_end'
//   -> payload.changes: Record<absPath, {type: 'add'|'update'|'delete', content?: string, unified_diff?: string}>

// File edits (SECONDARY PATH):
// response_item.payload.type === 'custom_tool_call' && payload.name === 'apply_patch'
//   -> payload.input: patch string in *** Begin Patch format

// Shell commands:
// response_item.payload.type === 'function_call' && payload.name === 'exec_command'
//   -> JSON.parse(payload.arguments).cmd: string
//   -> JSON.parse(payload.arguments).workdir: string
// Match to output via call_id in response_item.payload.type === 'function_call_output'
//   -> payload.output: parse after 'Output:\n'

// Git commit SHA extraction from exec_command output:
// const SHA_PATTERN = /\[(\S+)\s+([0-9a-f]{7,40})\]/;
// Apply to text after 'Output:\n' in function_call_output where cmd contains 'git commit'

// cwd: session_meta.payload.cwd (first occurrence per file)
// timestamp: top-level 'timestamp' field on each line
```

### 3.2 OpenCode parser

```typescript
// SQLite read-only (journal_mode=WAL, open with SQLITE_OPEN_READONLY)

// Session list:
// SELECT * FROM session ORDER BY time_created

// Message text:
// JOIN message m WITH part p ON p.message_id = m.id
// WHERE part.data.type IN ('text', 'reasoning')
// ORDER BY m.time_created, p.time_created

// User text: role='user' messages, parts with type='text'
// Assistant text: role='assistant' messages, parts with type='text'
// Reasoning: parts with type='reasoning'

// cwd: session.directory (created-time cwd) or assistant message.data.path.cwd (per-message)
// timestamp: Unix ms in message.time_created and part.time_created
```

---

## 4. Parsing traps

| trap | description |
|------|-------------|
| Double-JSON `arguments` | `function_call.payload.arguments` is a JSON-encoded string; must `JSON.parse()` it to get the object |
| `user_message` vs `message role=user` | Real user text is in `event_msg/user_message.payload.message`; `response_item/message role=user` is machine-injected context XML |
| `custom_tool_call` vs `function_call` | File edits use `custom_tool_call` (not `function_call`); `patch_apply_end` is in `event_msg`, not `response_item` |
| Compaction boundary | Lines before a `compacted` record may reference tool call IDs that have no corresponding `function_call` in the same file |
| Multi-`session_meta` per file | Same UUID; cwd is consistent across repetitions, but `cli_version` and `dynamic_tools` in older entries may differ |
| Relative vs absolute paths in patch | `apply_patch` uses relative paths for `Add File`/`Delete File`, absolute paths for `Update File` — always resolve relative to `session_meta.cwd` |
| OpenCode WAL | Open with WAL checkpoint or wait for WAL merge; raw WAL reads may miss recent writes |
| OpenCode `part.data` JSON | All `part.data` is a JSON string stored as TEXT column; must parse before accessing fields |
| `function_call_output.output` prefix | The prefix lines (Chunk ID, Wall time, Process exited, Original token count) are NOT part of stdout; strip before use |
