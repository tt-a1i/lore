<div align="center">

# lore

**The intent layer for Git** · links AI agent conversations to the code they wrote

[![npm](https://img.shields.io/npm/v/@tt-a1i/lore?color=1f883d&label=npm)](https://www.npmjs.com/package/@tt-a1i/lore)
[![license](https://img.shields.io/badge/license-Apache--2.0-1f883d)](LICENSE)
[![tests](https://img.shields.io/badge/tests-542%20passing-1f883d)](#)

[中文](README.md) · English

</div>

---

> **Git records what changed. lore records why.**

Code is cheap now; *understanding* is not. When agents write most of the code, the real requirements, the constraints discovered mid-flight, the approaches that got rejected — all of it lives in a conversation that evaporates the moment the session ends. Three weeks later you stare at a line and ask "why is this here?" and nobody can answer — including the you who prompted it.

lore catches that. It scans the agent transcripts **already on your disk** and links every commit to the conversation that produced it — then you can ask any line of code `why`:

```console
$ lore why src/server/upload-store.ts:42

commit: 1737b319  Add workspace upload evidence API
session: 13caa43d (2026-06-11, Claude Code)  ·  confidence 1.000 (strong)

  [USER]  Go ahead, fix all of it …
  [AGENT] Editing workspace-upload-store.ts (async IO, two-phase delete, startup sweep, ext regex…)
```

That's real output. What task produced this line, who asked for it, how it was decided — **back to the scene in 10 seconds.**

---

## Why lore

lore **sits on top of Git** — no new VCS, no editor switch, no team-wide migration. All data lives in a local `.lore/` directory that travels with the repo: no cloud, no account, no API key.

It serves two audiences, and agents are the headline act:

| For humans | For agents |
|---|---|
| `lore why <file>:<line>` — from any line of code back to the conversation behind it. Review code without guessing intent. | An MCP server + a set of hooks give any agent your project's memory: past decisions, rejected approaches, per-file constraints. **New sessions stop being cold starts.** |

### Full history the minute you install

Other tools start recording the day you install them; lore mines the transcripts **already on your disk** (Claude Code / Codex CLI / OpenCode) — your archive is already there. Installing it retroactively indexes your entire history.

---

## Quick start

```bash
# global install (the command is `lore`)
npm install -g @tt-a1i/lore

# one shot in your repo: scan → build graph → open the viewer
lore

# or call what you need
lore scan --repo .                       # index transcripts, run matching, build the graph
lore why src/app.ts:42                    # why does this line exist?
lore ask "how did we decide the retry logic"   # search the project's decision memory
lore status                              # freshness, coverage, notes summary
```

> Don't want a global install? Use `npx @tt-a1i/lore <command>`.

---

## How it works

Four steps, from loose transcripts to a queryable graph:

1. **Capture** — parse local transcripts from Claude Code, Codex CLI, and OpenCode into one unified event stream.
2. **Match** — a 3-tier engine attributes commits to sessions, handling squashes, worktrees, and rebases:
   - **T0** exact SHA anchoring from inside the transcript
   - **T1** content overlap between edits and commit hunks (weight 0.8)
   - **T2** per-file time-window correlation (weight 0.2)

   *Evidence floor*: a match under 3 overlapping lines can never reach the strong tier.
3. **Graph** — sessions, commits, files, and decisions in an embedded graph with **bi-temporal validity** — superseded decisions are invalidated, never deleted.
4. **Distill** — one `claude -p` call per session extracts decisions / constraints / rejected approaches, each anchored back to the exact messages.

---

## A day in an agent's life (this is lore's real home turf)

The classic agent failure: it sees a piece of "weird" code, confidently "fixes" it — and that code was written that way three weeks ago specifically to dodge a trap. lore stops this on two fronts:

**Pull (MCP)** — capable agents query on their own. Wire lore into any MCP host and the agent gets five tools:

```jsonc
// claude_desktop_config.json
{
  "mcpServers": {
    "lore": { "command": "lore", "args": ["mcp", "--repo", "/path/to/your/repo"] }
  }
}
```

`lore_why` · `lore_ask` · `lore_history` · `lore_note` (let an agent record a decision) · `lore_status`

**Push (hooks)** — weak / headless agents won't query on their own, so push the memory into their face instead:

```bash
lore hook install --repo .
```

Installs three Claude Code hooks at once:

- **SessionStart** → `lore brief` injects a project-memory briefing (active constraints + recent decisions + freshness)
- **PreToolUse** → `lore guard` injects the target file's constraints the instant the agent edits it (never blocks the tool, silent on any error)
- **Stop** → `lore scan` refreshes the index when the session ends, so the next one is never stale

---

## Does it actually work? (a controlled A/B)

We built a north-star eval: a compilable fixture repo with 6 planted, decidable constraints, and 6 coding tasks whose *natural* solutions each trip exactly one constraint — the task wording never hints a constraint exists. Same model, same prompts, blind double-judged, with the only variable being whether the agent can see lore.

| agent | bare (violations) | MCP pull | hook push |
|---|---|---|---|
| haiku (weak) | 3/6 (50%) | 2/6, **0 tool calls** | **0/6 (0%)** 🏆 |
| sonnet (strong) | 4/6 (67%) | **1/6**, 6/6 tool calls | — |

Two findings: **a strong agent with MCP cut violations from 4/6 to 1/6**, and it actually queried lore every time; **a weak agent won't query on its own** (haiku, 0/6 tool calls), but **hook-push drove its violations to zero** — beating even the strong agent's active querying.

The takeaway: **push covers every agent; pull serves strong agents' deep queries. lore does both.**

> Small sample (n=6/arm) — a pilot trend, not a proven effect size. The method, fixture, and judging are all open in [`eval/`](eval/); reproduce with `npx tsx eval/run.mts`.

---

## Commands

| Command | What it does |
|---|---|
| `lore` / `lore go` | Scan + build graph + open the viewer, one shot |
| `lore scan` | Index transcripts → match → build the graph |
| `lore why <file>:<line>` | Trace a line back to the conversation that produced it |
| `lore history <file>` | Full evolution timeline of a file with per-commit attribution |
| `lore ask "<question>" [--file <f>]` | Search decisions and conversations; `--file` scopes to one file's constraints |
| `lore note` | Manually record a Decision / Constraint / RejectedApproach |
| `lore status` | Freshness, coverage, notes summary |
| `lore distill` | LLM-distill sessions into semantic notes |
| `lore mcp` | Start the stdio MCP server (5 memory tools) |
| `lore brief` / `lore guard` | Push-based injection (called by hooks) |
| `lore hook install` | Install the three-hook set (push + auto-refresh) |
| `lore init` | Inject lore guidance into CLAUDE.md / AGENTS.md |
| `lore serve` | Local graph viewer — four views + timeline playback |

---

## Viewer — see your repo's memory

`lore serve` launches a zero-build, single-page D3 viewer locally. Four views share one timeline:

- **Story** — a narrative ledger: attributed commits grouped by session with green provenance rails; **click any commit to read the actual conversation** behind it
- **Graph** — force-directed knowledge graph; hover to highlight first-degree neighbours
- **Map** — repository treemap coloured by AI-attribution coverage: grey is a dark zone, green is fully traced
- **Decisions** — waterfall of distilled notes; superseded decisions are struck through and linked to their successor

Bilingual (follows browser language) with a light / dark toggle.

---

## Is the attribution trustworthy? (adversarial validation)

On a 726-commit production repo, independent verifier agents were explicitly told to **refute** every attribution:

- **100% strong-tier precision** (20/20 upheld; 80% on the weak tier)
- **71% coverage** (within the transcript-retention window; every blind spot accounted for — cloud sessions, merges, transcripts never written locally)
- **< 30s full scan** (55MB of transcripts, 709 commits, one pass)

And weak attributions (confidence < 0.8) are hidden by default — **guiding you to read a possibly-wrong conversation is worse than showing none.** Method and failure-mode analysis in [DESIGN.md](DESIGN.md).

---

## Roadmap

- git-notes interop (compatible with the git-ai standard)
- redaction + team sharing (synced via `refs/`)
- embedding retrieval (cross-language `ask`)
- code-survival weighting
- strong-agent validation of the push arm + a larger eval

---

## License

[Apache-2.0](LICENSE) © 2026 lore contributors

<div align="center">
<sub>Code written by AI deserves to be remembered by AI.</sub>
</div>
