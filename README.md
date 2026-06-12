# lore

**The intent layer for Git.** lore links AI agent conversations to the commits they produced — so you can ask any line of code *why it exists* and get the actual conversation that shaped it.

```
$ lore why src/server/upload-store.ts:42
→ commit 1737b319 "Add workspace upload evidence API"
→ session 13caa43d (2026-06-11, Claude Code)
   User: "可以，全部修复吧 …"
   Agent: 开始编辑 workspace-upload-store.ts（异步 IO、两阶段删除、启动清扫…）
```

## Why

Code is cheap now; understanding is not. When agents write most of the code, the *intent* — requirements as actually stated, constraints discovered mid-flight, approaches tried and rejected — lives in conversations that evaporate when the session ends. Git records what changed; lore records why.

- **For humans**: `lore why <file>:<line>` — from any line to the conversation behind it.
- **For agents**: an MCP server that gives any agent your project's episodic memory — past decisions, rejected approaches, the evolution of every file. New sessions stop being cold starts.

lore sits **on top of Git** — no new VCS, no migration, works with your existing repos and the transcripts already sitting on your disk.

## How it works

1. **Capture** — parses local agent transcripts (Claude Code today; Codex CLI and OpenCode next) into a unified event stream. Retroactive: your existing history is indexed the minute you install.
2. **Match** — a 3-tier engine attributes commits to sessions:
   - *Tier 0*: exact anchoring via commit SHAs recorded in the transcript
   - *Tier 1*: content overlap between transcript edits and commit hunks (weight 0.8)
   - *Tier 2*: per-file time-window correlation (weight 0.2)
   Handles squash merges, PR branches, git worktrees, and rebased history.
3. **Graph** *(M2+)* — sessions, commits, files, decisions and rejected approaches in an embedded knowledge graph (Kuzu), with bi-temporal validity (superseded decisions are marked, never deleted).

## Status

Early development — M1 (matching engine) is implemented and validated against real repos. Not yet published to npm.

```bash
git clone … && npm install
npx tsx src/cli.ts scan --repo /path/to/your/repo --broad
npx tsx src/cli.ts sample --repo /path/to/your/repo -n 10
```

`scan` writes `.lore/report.json` with per-(commit, file, session) attribution candidates, confidence scores and human-readable evidence. `sample` prints attribution samples with conversation excerpts for spot-checking.

## Roadmap

- **M1** ✅ Claude Code parser + 3-tier match engine + accuracy validation harness
- **M2** Skeleton knowledge graph (Kuzu) + `lore why <file>:<line>`
- **M3** Semantic distillation (decisions / constraints / rejected approaches) + MCP server
- **M4** Codex CLI & OpenCode parsers; graph viewer with timeline playback
- Later: git-notes interop (git-ai compatible), redaction + team sharing via refs

## Design notes

See [DESIGN.md](DESIGN.md) and [docs/research/transcript-format.md](docs/research/transcript-format.md) (empirical Claude Code transcript format documentation).

## License

Apache-2.0
