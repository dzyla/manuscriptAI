import type { DocType } from '../../../../src/services/review/types';

export interface FixtureSection {
  level: 1 | 2 | 3;
  title: string;
  paragraphs: string[];
}

/**
 * A planted weakness (the review should report it) or a trap (a passage that satisfies a check; a finding here is a
 * false alarm). The scorer assigns each finding to at most one expectation, in tiers: a planted weakness whose
 * quoteHint the finding's quote overlaps; a planted weakness by location (no quote and a primary section; or no
 * quoteHints and a primary section; or an alsoIn section whose `mention` the finding text matches); a trap by quote
 * overlap; a trap by location. Within a tier, an expectation with the finding's checkId wins, then fixture order.
 * A finding is on topic when its checkId equals the expectation's or its text matches `keywords`.
 */
export interface Expectation {
  id: string;
  checkId: string;
  sectionTitles: string[];
  quoteHints?: string[];
  /** Case-insensitive, no `g` flag (RegExp.test must stay stateless). */
  keywords: RegExp;
  alsoIn?: { sectionTitle: string; mention: RegExp }[];
  note: string;
}

export interface ReviewFixture {
  id: string;
  docType: DocType;
  mechanism?: string;
  projectYears?: number;
  sections: FixtureSection[];
  planted: Expectation[];
  traps: Expectation[];
}
