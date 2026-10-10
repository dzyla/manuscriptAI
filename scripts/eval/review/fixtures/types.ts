import type { DocType } from '../../../../src/services/review/types';

export interface FixtureSection {
  level: 1 | 2 | 3;
  title: string;
  paragraphs: string[];
}

/**
 * A planted weakness (the review should report it) or a trap (a passage that satisfies a check; a finding here is a
 * false alarm). A finding matches when it is on topic (same checkId, or its text matches `keywords`) AND located:
 * its quote overlaps a `quoteHints` entry; or it has no quote and sits in one of `sectionTitles`; or it carries no
 * quoteHints at all and sits in one of `sectionTitles`; or it sits in an `alsoIn` section and mentions `mention`.
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
