# lore

**The intent layer for Git.** lore links AI agent conversations to the commits they produced — so you can ask any line of code *why it exists* and get the actual conversation that shaped it.

```
$ lore why src/server/upload-store.ts:42
→ commit 1737b319 "Add workspace upload evidence API"
→ session 13caa43d (2026-06-11, Claude Code)
   User: "可以，全部修复吧 …"
   Agent: 开始编辑 workspace-upload-store.ts（异步 IO、两阶段删除、启动清扫…）
```

## Quick start

```bash
# From source (current state — pre-npm-publish):
git clone https://github.com/tt-a1i/lore.git
cd lore
npm install
npx tsx src/cli.ts scan --repo /path/to/your/git/repo

# After npm publish (coming soon):
# npx lore scan --repo /path/to/your/git/repo
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

| Command | Description |
|---------|-------------|
| `lore scan --repo <path> [--max-commits N] [--broad] [--no-graph]` | Index transcripts, run the match engine, write `.lore/report.json`, build the graph |
| `lore why <file>:<line> --repo <path> [--json]` | Trace any line of code back to the conversation that produced it |
| `lore history <file> --repo <path> [--json]` | Show the full evolution timeline of a file with conversation attributions per commit |
| `lore distill --repo <path> [--max-sessions N]` | LLM-distill sessions into Decision / Constraint / RejectedApproach notes via `claude -p` |
| `lore ask "<question>" --repo <path> [--include-superseded] [--json]` | Full-text search across distilled decisions and conversation messages |
| `lore note --repo <path> --kind <decision\|constraint\|rejected-approach> --title "…" --body "…" --source <agent\|human>` | Write a note directly (agent live-capture or human entry); deduplicates on title |
| `lore status --repo <path> [--json]` | Show attribution coverage, staleness, and note counts at a glance |
| `lore hook install --repo <path>` / `uninstall` | Install a Claude Code `Stop` hook that auto-runs `lore scan` after every session |
| `lore sample --repo <path> -n <N> [--tier strong\|weak]` | Sample matches from the report for spot-checking attribution accuracy |
| `lore mcp --repo <path>` | Start the stdio MCP server exposing `lore_why`, `lore_ask`, `lore_history`, `lore_note`, `lore_status` tools |
| `lore serve --repo <path> [--port 4017]` | Start the local graph viewer at `http://localhost:4017` |

### MCP server (for agents)

Add to your `claude_desktop_config.json` (or any MCP host):

```json
{
  "mcpServers": {
    "lore": {
      "command": "lore",
      "args": ["mcp", "--repo", "/path/to/your/repo"]
    }
  }
}
```

The agent gains five tools:

| MCP tool | What it does |
|----------|-------------|
| `lore_why` | Line-level attribution — which session wrote this line and why |
| `lore_ask` | Full-text search across distilled decisions and raw conversation messages |
| `lore_history` | File evolution timeline — every commit that touched a path with session attribution |
| `lore_note` | Write a decision / constraint / rejected-approach note with `source="agent"` (high-trust, deduplicates on title) |
| `lore_status` | One-shot coverage snapshot — staleness, match tier counts, note totals |

**Agent workflow example — a day with lore:**

```
# 1. Start of session: orient with a trust snapshot
lore_status
→ coverage 71%, last scan 2h ago, 12 active notes

# 2. Before touching a file: understand prior decisions
lore_ask "why is upload chunked at 4 MB?"
→ [agent] constraint: "4 MB chunk keeps memory under worker limit" (2026-05-14)

# 3. After discovering a new constraint mid-task: record it immediately
lore_note kind=constraint title="Retry must be idempotent — upload IDs are content-addressed" \
          body="Discovered during stress test: re-uploading identical bytes must be a no-op or downstream dedup breaks." \
          files=["src/upload/store.ts"] source=agent

# 4. Any time: trace a suspicious line
lore_why src/upload/store.ts:87
→ session 13caa43d (2026-06-11) — User: "两阶段删除 …"
```

New sessions stop being cold starts; notes written by agents surface with an `[agent]` badge in the viewer.

Or use `lore hook install --repo <path>` to run `lore scan` automatically after every Claude Code session — no manual step needed.

## Viewer — four views

Launch with `lore serve --repo <path>` and open `http://localhost:4017`.

| View | Description |
|------|-------------|
| **Story** (key `1`) | Horizontal timeline: session swimlanes, commits scaled by file-touch count, attribution ribbons (Bézier, width proportional to confidence), decision diamonds with supersede chains |
| **Graph** (key `2`) | Force-directed knowledge graph: sessions, commits, files, and decisions as nodes; PRODUCED / TOUCHES / EDITED edges; hover to highlight first-degree neighbours |
| **Map** (key `3`) | Treemap of the repository — cells coloured by AI attribution coverage (grey = dark zone, green = fully traced); toggle by commit count or lines changed |
| **Decisions** (key `4`) | Waterfall card stream of all distilled notes; full-text search; bi-temporal supersede chains; timeline slider dims invalidated decisions |

All four views share a timeline scrubber — drag it to replay the repo's history from day one.

Screenshots (to be added — see `docs/assets/*.png` once captured):
- `docs/assets/view-story.png` — story timeline view
- `docs/assets/view-graph.png` — force-directed graph view
- `docs/assets/view-map.png` — repository treemap
- `docs/assets/view-decisions.png` — decisions card stream

## Status & validation

All four milestones implemented (version 0.1.0, not yet published to npm). Validated on a 726-commit production repo:

- **Attribution precision**: adversarial verification (30 samples, independent verifier agents instructed to *refute* each attribution) measured **100% on strong-tier matches** (20/20), 80% on weak tier.
- **Coverage**: 71% of commits inside the transcript-retention window matched; every blind spot is accounted for (sessions whose transcripts were never written locally, merge commits, cloud sessions).
- **Distillation**: real sessions produced anchored constraints, including a correct bi-temporal supersede chain.

## Roadmap

- **M1** ✅ Claude Code parser + 3-tier match engine + adversarial validation harness
- **M2** ✅ Graph layer (JSON/Kuzu adapter) + `lore why` + `lore history`
- **M3** ✅ Semantic distillation (bi-temporal notes) + `lore ask` + MCP server
- **M4** ✅ Codex CLI & OpenCode parsers; four-view local viewer with timeline playback
- Next: git-notes interop (git-ai compatible), redaction + team sharing via refs, embedding retrieval backend, code-survival weighting

## Design notes

See [DESIGN.md](DESIGN.md) and [docs/research/transcript-format.md](docs/research/transcript-format.md) (empirical Claude Code transcript format documentation).

## License

Apache-2.0 — copyright 2026 lore contributors
