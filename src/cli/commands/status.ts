import fs from 'node:fs/promises';
import path from 'node:path';

import type { RepoMatchReport } from '../../match/types.js';
import { execFileAsync } from '../../util/exec.js';
import { renderStatusCard } from '../render.js';
import { bold, yellow } from '../ui.js';

interface LoreReportFile extends RepoMatchReport {
  sessionSourceMap: Record<string, string>;
  skippedBySession: Record<string, { count: number; samples: string[] }>;
}

type NotesFileSummary = {
  notes: { kind: string; source?: string; invalidAt: string | null }[];
  distilledAt?: string;
};

export async function cmdStatus(opts: { repo: string; json?: boolean }): Promise<void> {
  const repoPath = path.resolve(opts.repo);

  const reportPath = path.join(repoPath, '.lore', 'report.json');
  let report: LoreReportFile;
  try {
    const raw = await fs.readFile(reportPath, 'utf8');
    report = JSON.parse(raw) as LoreReportFile;
  } catch {
    if (opts.json) {
      console.log(JSON.stringify({
        schemaVersion: 1,
        status: 'no-report',
        message: `run-scan-first: lore scan --repo ${repoPath}`,
      }, null, 2));
    } else {
      console.log(
        `\n${yellow('⚠')}  No lore data found for: ${repoPath}\n\n` +
        `  To get started, run:\n` +
        `    ${bold(`lore scan --repo ${repoPath}`)}\n` +
        `\n  Or for a one-step scan + viewer:\n` +
        `    ${bold(`lore go --repo ${repoPath}`)}\n`,
      );
    }
    return;
  }

  const notesPath = path.join(repoPath, '.lore', 'notes.json');
  let notesFile: NotesFileSummary | null = null;
  try {
    const raw = await fs.readFile(notesPath, 'utf8');
    notesFile = JSON.parse(raw) as NotesFileSummary;
  } catch {
    // Missing notes.json is not an error — distill hasn't run yet.
  }

  let headTime: string | null = null;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'log', '-1', '--format=%cI'],
      { encoding: 'utf8' },
    );
    headTime = stdout.trim() || null;
  } catch {
    // git not available — skip.
  }

  if (opts.json) {
    const generatedMs = Date.parse(report.generatedAt);
    const FOUR_H = 4 * 60 * 60 * 1000;
    const headNewer = headTime ? Date.parse(headTime) > generatedMs : false;
    const isStale = isNaN(generatedMs) || Date.now() - generatedMs > FOUR_H || headNewer;

    const activeNotes = notesFile?.notes.filter((n) => n.invalidAt === null) ?? [];
    const byKind: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    for (const n of activeNotes) {
      byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
      const src = n.source ?? 'distilled';
      bySource[src] = (bySource[src] ?? 0) + 1;
    }

    console.log(JSON.stringify({
      schemaVersion: 1,
      status: isStale ? 'stale' : 'fresh',
      generatedAt: report.generatedAt,
      headCommitTime: headTime,
      coverage: {
        commitsTotal: report.commitsTotal,
        strong: report.commitsMatchedStrong,
        weak: report.commitsMatchedWeak,
        inWindow: report.commitsInWindow,
        strongInWindow: report.strongInWindow,
        weakInWindow: report.weakInWindow,
        window: report.window,
      },
      sessions: report.sessionsSeen,
      notes: {
        total: notesFile?.notes.length ?? 0,
        active: activeNotes.length,
        byKind,
        bySource,
        distilledAt: notesFile?.distilledAt ?? null,
      },
    }, null, 2));
    return;
  }

  console.log(renderStatusCard({
    repoPath,
    report,
    notesFile,
    headTime,
    nowMs: Date.now(),
  }));
}
