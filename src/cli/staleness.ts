/**
 * Determine whether a report is stale relative to now / a HEAD commit time.
 * Pure-ish logic (injectable nowMs + headTime for testability).
 * Returns a warning string to emit, or null if fresh.
 *
 * Staleness conditions:
 *   - HEAD commit is newer than generatedAt, OR
 *   - generatedAt is more than 4 hours before nowMs.
 */
export function staleness(opts: {
  generatedAt: string;
  nowMs: number;
  headTime: string | null;
  repoPath: string;
  useColor: boolean;
}): string | null {
  const { generatedAt, nowMs, headTime, repoPath, useColor } = opts;
  const generatedMs = Date.parse(generatedAt);
  if (isNaN(generatedMs)) return null;

  const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
  const ageStale = nowMs - generatedMs > FOUR_HOURS_MS;

  let headNewer = false;
  if (headTime) {
    const headMs = Date.parse(headTime);
    if (!isNaN(headMs) && headMs > generatedMs) {
      headNewer = true;
    }
  }

  if (!headNewer && !ageStale) return null;

  const genStr = generatedAt.slice(0, 19).replace('T', ' ');
  const headStr = headTime ? headTime.slice(0, 19).replace('T', ' ') : 'unknown';
  const warnLabel = useColor ? `\x1b[1;33mWARNING\x1b[0m` : 'WARNING';
  return (
    `${warnLabel}: lore data is stale (generated ${genStr}, HEAD ${headStr})` +
    ` — run \`lore scan --repo ${repoPath}\`\n`
  );
}
