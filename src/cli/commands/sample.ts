import fs from 'node:fs/promises';
import path from 'node:path';
import type { ParseResult, ParsedSession, FileEditEvent, TranscriptParser } from '../../schema/events.js';
import type { RepoMatchReport, MatchCandidate } from '../../match/types.js';
import { tierOf } from '../../match/types.js';
import { truncate } from '../../util/text.js';

interface LoreReportFile extends RepoMatchReport {
  sessionSourceMap: Record<string, string>;
  skippedBySession: Record<string, { count: number; samples: string[] }>;
}

async function loadParsers(): Promise<TranscriptParser[]> {
  const mod = await import('../../parsers/registry.js');
  return mod.allParsers as TranscriptParser[];
}

function randomSample<T>(arr: T[], n: number): T[] {
  const copy = arr.slice();
  const result: T[] = [];
  while (result.length < n && copy.length > 0) {
    const idx = Math.floor(Math.random() * copy.length);
    result.push(copy.splice(idx, 1)[0] as T);
  }
  return result;
}

export async function cmdSample(opts: {
  repo: string;
  n: string;
  tier?: string;
  json?: boolean;
}): Promise<void> {
  const repoPath = path.resolve(opts.repo);
  const n = parseInt(opts.n, 10);
  if (isNaN(n) || n <= 0) {
    console.error('Error: -n must be a positive integer');
    process.exit(1);
  }

  const tier = opts.tier as 'strong' | 'weak' | undefined;
  if (tier !== undefined && tier !== 'strong' && tier !== 'weak') {
    console.error('Error: --tier must be "strong" or "weak"');
    process.exit(1);
  }

  const reportPath = path.join(repoPath, '.lore', 'report.json');
  let loreReport: LoreReportFile;
  try {
    const raw = await fs.readFile(reportPath, 'utf8');
    loreReport = JSON.parse(raw) as LoreReportFile;
  } catch {
    console.error(`Error: cannot read ${reportPath}. Run "lore scan" first.`);
    process.exit(1);
  }

  // Filter by tier
  let pool: MatchCandidate[];
  if (tier) {
    pool = loreReport.matches.filter((m) => tierOf(m.confidence) === tier);
  } else {
    pool = loreReport.matches.filter((m) => tierOf(m.confidence) !== 'none');
  }

  if (pool.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify({ schemaVersion: 1, matches: [] }, null, 2));
    } else {
      console.log(`No matches found${tier ? ` for tier "${tier}"` : ''}.`);
    }
    return;
  }

  const sampled = randomSample(pool, Math.min(n, pool.length));
  const parsers = await loadParsers();

  // Group by sessionId to avoid re-parsing the same file multiple times.
  // 按解析单元（candidate.sourcePath）分组——证据上下文必须取自真正包含编辑的文件，
  // 同 sessionId 的父 session 与子 agent 是不同解析单元。
  const bySource = new Map<string, MatchCandidate[]>();
  for (const m of sampled) {
    const src = m.sourcePath || loreReport.sessionSourceMap[m.sessionId] || '';
    const arr = bySource.get(src) ?? [];
    arr.push(m);
    bySource.set(src, arr);
  }

  if (opts.json) {
    // In JSON mode, collect structured results and emit once
    const jsonMatches: object[] = [];
    for (const [sourcePath, matches] of bySource) {
      if (!sourcePath) continue;
      let parseResult: ParseResult | null = null;
      for (const p of parsers) {
        try { parseResult = await p.parse(sourcePath); break; } catch { /* try next */ }
      }
      for (const match of matches) {
        const excerpts: object[] = [];
        if (parseResult) {
          const { events } = parseResult.session;
          const editSeqSet = new Set(match.editSeqs);
          const editEvents = events.filter((e) => e.kind === 'file-edit' && editSeqSet.has(e.seq));
          for (const editEvt of editEvents) {
            const idx = events.findIndex((e) => e.seq === editEvt.seq);
            if (idx === -1) continue;
            for (let i = idx - 1; i >= 0; i--) {
              const e = events[i];
              if (!e) continue;
              if (e.kind === 'user-message' || e.kind === 'assistant-message') {
                excerpts.push({ seq: e.seq, role: e.kind === 'user-message' ? 'user' : 'assistant', text: truncate(e.text.trim(), 300) });
                break;
              }
            }
          }
        }
        jsonMatches.push({
          commitHash: match.commitHash,
          filePath: match.filePath,
          sessionId: match.sessionId,
          confidence: match.confidence,
          tier: tierOf(match.confidence),
          matchedVia: match.matchedVia,
          matchedLines: match.matchedLines,
          sourcePath,
          evidence: match.evidence,
          excerpts,
        });
      }
    }
    console.log(JSON.stringify({ schemaVersion: 1, matches: jsonMatches }, null, 2));
    return;
  }

  console.log(`\n# lore sample — ${sampled.length} match(es) from ${repoPath}\n`);

  for (const [sourcePath, matches] of bySource) {
    if (!sourcePath) {
      console.warn(`WARN: no sourcePath for ${matches.length} match(es), skipping`);
      continue;
    }

    // Pick the right parser for this source path by trying each in turn.
    let parseResult: ParseResult | null = null;
    for (const p of parsers) {
      try {
        parseResult = await p.parse(sourcePath);
        break;
      } catch {
        // not this parser's format — try the next one
      }
    }
    if (parseResult === null) {
      console.warn(`WARN: failed to re-parse ${sourcePath} with any known parser`);
    }

    for (const match of matches) {
      await renderSampleBlock(match, sourcePath, parseResult);
    }
  }
}

async function renderSampleBlock(
  match: MatchCandidate,
  sourcePath: string,
  parseResult: { session: ParsedSession } | null,
): Promise<void> {
  const tierLabel = tierOf(match.confidence);
  console.log('─'.repeat(72));
  console.log(`## Commit: ${match.commitHash}  file: ${match.filePath}`);
  console.log(`   Session: ${match.sessionId}`);
  console.log(`   Confidence: ${match.confidence.toFixed(3)} (${tierLabel})`);
  if (match.evidence.length > 0) {
    console.log(`   Evidence:`);
    for (const e of match.evidence) {
      console.log(`     • ${e}`);
    }
  }
  console.log(`   Source: ${sourcePath}`);
  console.log('');

  if (!parseResult) {
    console.log('   [session could not be re-parsed]');
    console.log('');
    return;
  }

  const { events } = parseResult.session;
  const editSeqSet = new Set(match.editSeqs);

  // Find the edit events that contributed
  const editEvents = events.filter(
    (e) => e.kind === 'file-edit' && editSeqSet.has(e.seq),
  );

  if (editEvents.length === 0) {
    console.log('   [no contributing edit events found in session]');
    console.log('');
    return;
  }

  // For each edit event, find the nearest user-message and assistant-message
  // that precede and follow it in the event stream.
  for (const editEvt of editEvents) {
    const idx = events.findIndex((e) => e.seq === editEvt.seq);
    if (idx === -1) continue;

    // Search backwards for nearest user-message
    let nearestUserBefore: string | null = null;
    for (let i = idx - 1; i >= 0; i--) {
      const e = events[i];
      if (!e) continue;
      if (e.kind === 'user-message') {
        nearestUserBefore = truncate(e.text.trim(), 300);
        break;
      }
    }

    // Search backwards for nearest assistant-message
    let nearestAssistantBefore: string | null = null;
    for (let i = idx - 1; i >= 0; i--) {
      const e = events[i];
      if (!e) continue;
      if (e.kind === 'assistant-message') {
        nearestAssistantBefore = truncate(e.text.trim(), 300);
        break;
      }
    }

    // Search forwards for nearest user-message
    let nearestUserAfter: string | null = null;
    for (let i = idx + 1; i < events.length; i++) {
      const e = events[i];
      if (!e) continue;
      if (e.kind === 'user-message') {
        nearestUserAfter = truncate(e.text.trim(), 300);
        break;
      }
    }

    // Search forwards for nearest assistant-message
    let nearestAssistantAfter: string | null = null;
    for (let i = idx + 1; i < events.length; i++) {
      const e = events[i];
      if (!e) continue;
      if (e.kind === 'assistant-message') {
        nearestAssistantAfter = truncate(e.text.trim(), 300);
        break;
      }
    }

    console.log(`   Edit seq=${editEvt.seq}  op=${editEvt.kind === 'file-edit' ? (editEvt as FileEditEvent).op : '?'}`);

    if (nearestUserBefore) {
      console.log(`   [USER before]`);
      console.log(`   > ${nearestUserBefore}`);
    }
    if (nearestAssistantBefore) {
      console.log(`   [ASSISTANT before]`);
      console.log(`   > ${nearestAssistantBefore}`);
    }
    if (nearestUserAfter) {
      console.log(`   [USER after]`);
      console.log(`   > ${nearestUserAfter}`);
    }
    if (nearestAssistantAfter) {
      console.log(`   [ASSISTANT after]`);
      console.log(`   > ${nearestAssistantAfter}`);
    }
    console.log('');
  }
}
