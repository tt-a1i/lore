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

1. **Capture** — parses local agent transcripts (Claude Code, Codex CLI, OpenCode) into a unified event stream. Retroactive: your existing history is indexed the minute you install.
2. **Match** — a 3-tier engine attributes commits to sessions:
   - *Tier 0*: exact anchoring via commit SHAs recorded in the transcript
   - *Tier 1*: content overlap between transcript edits and commit hunks (weight 0.8)
   - *Tier 2*: per-file time-window correlation (weight 0.2)
   Handles squash merges, PR branches, git worktrees, rebased history, and workflow subagents. Evidence floor: matches under 3 overlapping lines never reach the strong tier.
3. **Graph** — sessions, commits, files and distilled decisions in an embedded graph (JSON store by default; Kuzu available via `LORE_GRAPH_BACKEND=kuzu`), with bi-temporal validity: superseded decisions are marked invalid, never deleted.
4. **Distill** — one `claude -p` (headless Claude Code, no API key setup) call per session extracts decisions / constraints / rejected approaches, each anchored back to the exact conversation messages.

## Commands

```bash
npx tsx src/cli.ts scan    --repo <path> --broad     # index transcripts → match → build graph
npx tsx src/cli.ts why     <file>:<line> --repo <path>  # any line → the conversation behind it
npx tsx src/cli.ts history <file> --repo <path>      # file evolution timeline with attributions
npx tsx src/cli.ts distill --repo <path> [--max-sessions N]  # LLM-distill sessions into notes
npx tsx src/cli.ts ask     "<question>" --repo <path>   # search decisions + conversations
npx tsx src/cli.ts sample  --repo <path> -n 10       # spot-check attribution accuracy
npx tsx src/cli.ts mcp     --repo <path>             # MCP server: lore_why / lore_ask / lore_history
npx tsx src/cli.ts serve   --repo <path> --port 4017 # D3 graph viewer with timeline playback
```

Point your agent at the MCP server and it gains your project's episodic memory — past decisions, rejected approaches, and the evolution of every file.

## Status & validation

All four milestones implemented (not yet published to npm). Validated on a 726-commit production repo:

- **Attribution precision**: adversarial verification (30 samples, independent verifier agents instructed to *refute* each attribution) measured **100% on strong-tier matches** (20/20), 80% on weak tier.
- **Coverage**: 71% of commits inside the transcript-retention window matched; every blind spot is accounted for (sessions whose transcripts were never written locally, merge commits, cloud sessions).
- **Distillation**: real sessions produced anchored constraints, including a correct bi-temporal supersede chain.

## Roadmap

- **M1** ✅ Claude Code parser + 3-tier match engine + adversarial validation harness
- **M2** ✅ Graph layer (JSON/Kuzu adapter) + `lore why` + `lore history`
- **M3** ✅ Semantic distillation (bi-temporal notes) + `lore ask` + MCP server
- **M4** ✅ Codex CLI & OpenCode parsers; D3 graph viewer with timeline playback
- Next: git-notes interop (git-ai compatible), redaction + team sharing via refs, embedding retrieval backend, code-survival weighting

## Design notes

See [DESIGN.md](DESIGN.md) and [docs/research/transcript-format.md](docs/research/transcript-format.md) (empirical Claude Code transcript format documentation).

## License

Apache-2.0
