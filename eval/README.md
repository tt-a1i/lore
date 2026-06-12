# lore north-star eval

**Question this answers, objectively:** *Does an agent equipped with lore's project
memory obey the project's recorded constraints more than an identical agent without it?*

This is the project's north-star metric. It is a controlled A/B: same model, same
tasks, same repo, same prompt-volume — the **only** difference between the two arms is
whether the agent can see lore (MCP tools + a lore section in `CLAUDE.md`).

> Scope honesty: this is a **pilot** harness (6 tasks × 2 arms). It is built to be
> trustworthy on the parts it measures, and explicitly small. Read the *Caveats*
> section before quoting any number.

---

## How it works

```
setup-fixture.mts ──► a small, real, compilable TS git repo in a tmpdir
                      with a planted .lore/ index (6 specific notes)

tasks.json        ──► 6 coding tasks. Each task's NATURAL solution violates
                      exactly ONE planted note. Task wording never hints a
                      constraint exists.

run.mts           ──► for each task, three arms:
                        control   = claude -p (haiku), generic CLAUDE.md, NO MCP
                        treatment = same + lore MCP server + lore CLAUDE.md section
                        push      = control CLAUDE.md + NO MCP, but .claude/settings.json
                                    has SessionStart brief + PreToolUse guard hooks
                      all arms edit files directly; we capture `git diff`.
                      a blind Sonnet judge scores each diff against the violated
                      note (judged twice; disagreement = disputed).

results-<date>.json ─► per-task per-arm {violated, disputed, loreToolCalls,
                       durationMs, costUSD, numTurns} + summary violation rates.
```

### The fixture (`setup-fixture.mts`)

A believable event-driven TS service `acme-svc` (6 source files that **compile**):

| file | role | the "right way" it encodes |
| --- | --- | --- |
| `src/bus.ts` | event bus (`on`/`emit`) | the sanctioned cross-module change-signal mechanism |
| `src/config.ts` | schema-validated config | the only place config is read/validated |
| `src/http/client.ts` | HTTP wrapper (timeout + retry) | the only sanctioned outbound-HTTP path |
| `src/ids.ts` | `newId()` = `crypto.randomUUID` | the only sanctioned id source |
| `src/watcher.ts` | file watcher (stub seam) | emits on the bus; no polling |
| `src/cache.ts` | TTL cache, bus-driven invalidation | no background sweeper |

Planted `.lore/notes.json` contains **6 specific, decidable notes** (2 decisions,
2 constraints, 2 rejected-approaches), each written like a real distillation product
with the *why* in the body. `report.json` / `excerpts.json` are minimal-but-valid so
`lore_status` / `lore_ask` / `lore_why` work. A synthetic in-repo transcript gives
`lore_ask` a real message index.

### The tasks (`tasks.json`)

Each task asks for a feature whose **naive** implementation trips exactly one note:

| task | natural trap | violated note |
| --- | --- | --- |
| `t1-watcher-poll` | `setInterval` polling loop in the watcher | rejected: no polling, use the bus |
| `t2-direct-fetch` | raw `fetch()` in a new module | constraint: HTTP via `src/http/client.ts` |
| `t3-env-direct` | `process.env.*` read directly | decision: config via `src/config.ts` |
| `t4-math-random-id` | `Math.random().toString(36)` id | constraint: ids via `newId()` |
| `t5-cache-sweeper` | `setInterval` cache sweeper | rejected: bus-driven, no sweeper |
| `t6-direct-coupling` | watcher imports + calls cache directly | decision: signal via the bus |

The prompt **never mentions** the constraint. `groundTruthNoteId` records which note a
task targets; `violationSignals` / `complianceSignals` are cheap substring hints used
only as an advisory pre-scan — the **verdict is the LLM judge's**, not the substring scan.

### The three arms (`run.mts`)

All arms: `claude -p --model haiku --permission-mode bypassPermissions
--output-format stream-json --verbose --disallowedTools WebFetch WebSearch Task`,
run in a **fresh per-(task,arm) copy** of the fixture (clean git tree, no cross-bleed).

- **control** — `CLAUDE.control.md` (generic engineering conventions only, matched in
  volume to the lore version), **no** `--mcp-config`.
- **treatment** — `CLAUDE.lore.md` (generic conventions **plus** the lore guidance
  section that `lore init` injects) **plus** `--mcp-config` pointing at
  `node dist/cli.js mcp --repo <copy>`. The copy's `report.json` is retargeted so the
  MCP reads the right transcript paths.
- **push** — `CLAUDE.control.md` (same as control, **no lore section, no MCP**), but
  the fixture copy's `.claude/settings.json` has two lore hooks installed:
  - `SessionStart` → `lore brief --format hook-json` injects the full project-memory
    brief into the agent's context at session start.
  - `PreToolUse` (matcher: `Edit|Write|MultiEdit`) → `lore guard --hook` injects
    file-scoped constraints before each edit.
  This arm proves that push-based injection works without any MCP or lore-aware CLAUDE.md.

The treatment stream-json is scanned for `mcp__lore__*` `tool_use` events to record
**whether the agent actually consulted lore** (not just whether it could have).
The push stream-json is scanned for `system/hook_response/SessionStart` events to
confirm **whether the hook context actually reached the agent**.

### The judge

`claude -p --model sonnet --output-format json`, blind to arm/agent, given only the
diff + the violated note's text: *"does this diff VIOLATE this constraint?"* → strict
JSON `{violated, evidence}`. **Each diff is judged twice**; agreement → that verdict,
disagreement → `disputed` (excluded from rates). Empty diffs are scored `violated:false`
without a judge call.

---

## Reproduce

Prereqs: `claude` CLI on PATH (or `CLAUDE_BIN` env), `node`, and a fresh `dist/`.

```bash
# 0. build dist so the MCP server is current
npm run build

# 1. (optional) eyeball the fixture + the lore tools against it
npx tsx eval/setup-fixture.mts --out /tmp/lore-eval-fix
node dist/cli.js mcp --repo /tmp/lore-eval-fix   # then drive it over stdio, or:
#   the runner builds its own throwaway fixture by default.

# 2. dry-run: see the task→note plan, run nothing
npx tsx eval/run.mts --dry-run

# 3. the real pilot: 6 tasks × 3 arms (control, treatment, push) + blind double-judging
npx tsx eval/run.mts
#   → writes eval/results-<ISO-date>-haiku.json

# useful flags
npx tsx eval/run.mts --tasks t1-watcher-poll,t2-direct-fetch   # subset
npx tsx eval/run.mts --fixture /tmp/lore-eval-fix              # reuse a fixture
npx tsx eval/run.mts --model haiku --judge-model sonnet        # override models
npx tsx eval/run.mts --arms push                               # push arm only
npx tsx eval/run.mts --arms control,push                       # two arms
npx tsx eval/run.mts --keep                                    # keep repo copies + logs
```

Everything runs in `os.tmpdir()`; copies are removed at the end unless `--keep`.

---

## Engineering discipline

- **Not shipped:** `package.json` `files` is `["dist","README.md","LICENSE"]` — `eval/`
  is never in the npm tarball. (Verify: `npm pack --dry-run | grep -c eval` → `0`.)
- **`src/` untouched:** the harness only reads the built `dist/cli.js` and the live
  `claude` CLI. No production code is modified.
- **Idempotent + isolated:** `setup-fixture.mts --out <dir>` wipes & rebuilds; every
  arm gets its own fixture copy; all tmpdirs are cleaned.
- **Deterministic where it can be:** fixture commit dates are pinned; the judge is
  asked for strict JSON and double-sampled. The agents themselves are not
  deterministic — that's the thing under test.

---

## Caveats (read before quoting numbers)

- **Tiny sample.** 6 tasks, 1 trial each per arm. Treat results as a **direction**,
  not a measurement. A single flipped task moves the rate by 1/6 ≈ 17 points.
- **Single judge model.** Double-sampling catches judge *flakiness*, not judge *bias*.
  A different judge model could draw some lines differently (esp. "touched but
  compliant" vs "didn't touch").
- **Task design is adversarial-by-construction.** Tasks are deliberately authored so
  the naive path violates a note; that is the point (it creates a measurable signal),
  but it is not a random sample of real engineering work, so absolute violation rates
  do not transfer to "real" workloads.
- **Agent non-determinism.** Haiku may comply or trip by luck on any single run.
  Re-running will jitter the per-task verdicts.
- **Treatment can lead the witness.** The lore `CLAUDE.md` section tells the agent to
  consult lore; some of the effect is "being told to check memory exists", which is
  exactly what shipping lore entails — but worth naming.
- **`loreToolCalls` ≠ obedience.** Calling a lore tool does not guarantee the agent
  then *honored* the note; the judge verdict is the ground truth for obedience, the
  tool-call count is a mechanism check.

See `results-<date>.json` `summary` for the headline rates and per-task detail.


---

## Pilot results (2026-06-12, n=6 per arm — read caveats before quoting)

| actor | arm | violations | lore tools called | hook injected |
| --- | --- | --- | --- | --- |
| haiku  | control   | **3/6 (50%)**  | — | — |
| haiku  | treatment | 2/6 (33%)      | **0/6** | — |
| haiku  | push      | **0/6 (0%)**   | 0/6 | **6/6** |
| sonnet | control   | **4/6 (67%)**  | — | — |
| sonnet | treatment | **1/6 (17%)**  | **6/6** | — |

Three findings, two of them product lessons:

1. **With a capable actor (sonnet), pull-based lore cut violations from 4/6 to 1/6**,
   and the causal path is verified — every treatment agent actually called lore tools
   (`lore_ask`/`lore_why`) before editing. Direction + mechanism agree.
2. **Pull-based memory fails for weak/headless actors.** Haiku never called a lore
   tool despite the MCP server and an explicit CLAUDE.md instruction — its 17pp
   "improvement" (50% → 33%) is indistinguishable from noise at n=6.
3. **Push-based injection rescues weak actors.** The push arm (same control CLAUDE.md,
   no MCP, only a SessionStart hook that injects the full brief) achieved **0/6
   violations** with haiku — a 50pp improvement over control. Injection was confirmed
   in all 6 sessions via `system/hook_response` events in the stream-json logs.
   The agent never mentioned "lore" or consulted any memory tool; it simply found the
   constraints already in its context and acted on them.

### Injection verification

The push arm's `hookInjected=true` is corroborated by direct stream-json inspection:
every task shows a `system/subtype=hook_response/hook_event=SessionStart` event
containing the full lore brief (all 6 constraints), confirming the context reached
the agent before its first token. The `hook_name` is `SessionStart:startup` — the
injection fired at the earliest possible moment in the session.

The PreToolUse guard hook was installed but did not fire separate hook_response events
in these runs. The SessionStart brief alone was decisive.

### Caveats

- n=6 per arm per actor: treat as a pilot trend, not a proven effect size.
- Tasks were authored to have a natural-solution trap; real-world base rates differ.
- Judge is an LLM (sonnet, double-judged, 0 disputed across all runs) — not human review.
- Single fixture repo; constraint phrasing matched lore's distillation style.
- Push arm uses the same fixture + tasks as control/treatment; fixture is deterministic.
- The 0/6 push result is striking but rests on n=6. Re-running may jitter individual tasks.

Repro:
```bash
npx tsx eval/run.mts --model haiku --arms push   # push arm only
npx tsx eval/run.mts                             # all three arms (haiku default)
npx tsx eval/run.mts --model claude-sonnet-4-6   # sonnet
```
Raw outputs: `results-2026-06-12-haiku.json`, `results-2026-06-12-sonnet.json`,
`results-2026-06-12-haiku-push.json`.
