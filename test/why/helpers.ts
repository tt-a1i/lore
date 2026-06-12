/**
 * Test-only shape for the minimal .lore/report.json the why engine reads.
 * The engine only consumes `matches`; we keep the fixture lean.
 */

import type { MatchCandidate } from '../../src/match/types.js';

export interface LoreReportFileShape {
  matches: MatchCandidate[];
}
