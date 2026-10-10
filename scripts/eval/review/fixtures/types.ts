import type { DocType } from '../../../../src/services/review/types';

export interface FixtureSection {
  level: 1 | 2 | 3;
  title: string;
  paragraphs: string[];
}

/**
 * A planted weakness (the review should report it) or a trap (a passage that satisfies a check; a finding here is a
 * false alarm). The scorer assigns each finding to at most one expectation. Tiers, planted first and then traps:
 * (a) the finding's checkId equals the expectation's and its quote overlaps a quoteHint; (b) checkId equal and located
 * (no quote and a primary section; or no quoteHints and a primary section; or an alsoIn section whose `mention` the
 * finding text matches); (c) keyword-only (`keywords` match the finding text) and quote overlap; (d) keyword-only and
 * located. Within a tier, fixture order. The checkId therefore outranks keywords, planted outranks traps, and a quote
 * outranks a location.
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
