import type { AuditSummary, SentenceAudit } from '../../types';
import { styleDistance, type MetricDeviation } from '../../services/proseAudit/score';
import { TELL_PATTERNS } from '../../services/proseAudit/patterns';

export interface StyleRow extends MetricDeviation {
  /**
   * The metric's own name, shown next to the label ONLY when it differs from it. Several
   * metrics share a label ('rather than' and 'instead of' are both "contrastive definition"),
   * so the label alone would produce two identical-looking rows.
   */
  name: string | null;
  unit: string;
}

export interface StyleReadout {
  score: number;
  band: 'close' | 'drifting' | 'far';
  /** scored metrics where the draft or the voice is non-zero, worst drift first */
  rows: StyleRow[];
  /**
   * Sentence-length variation. Measured, but deliberately NOT scored (see profile.ts):
   * kept out of `rows` so the UI can show it separately. `voice` is null when the
   * reference has no measured value (the generic baseline).
   */
  lengthCv: { draft: number; voice: number | null };
  /** Triples per 100 sentences. Measured, not scored: the author's own prose saturates it (see profile.ts). */
  tricolon: { draft: number; voice: number | null };
}

/** Pure view-model for the panel: everything the table and score card render. */
export function styleRows(draft: AuditSummary, voice: AuditSummary): StyleReadout {
  const { score, band, deviations } = styleDistance(draft, voice);
  const rows: StyleRow[] = deviations
    .filter(d => d.draft > 0 || d.voice > 0)
    .map(d => ({
      ...d,
      name: TELL_PATTERNS[d.metric] && d.label !== d.metric ? d.metric : null,
      unit: d.metric === 'meanWords' ? 'words' : d.metric === 'pctOver35' ? '%' : 'per 100 sentences',
    }));
  return {
    score,
    band,
    rows,
    lengthCv: { draft: draft.lengthCv ?? 0, voice: voice.lengthCv > 0 ? voice.lengthCv : null },
    tricolon: { draft: draft.rates?.tricolon ?? 0, voice: voice.rates?.tricolon ?? null },
  };
}

/** Below this many sentences a section's score is noise (one sentence can swing every rate), so it is shown as "not measured". */
export const MIN_SECTION_SENTENCES = 5;

export interface SectionRow {
  title: string;
  sentences: number;
  /** null when the section is too short to measure */
  score: number | null;
  band: 'close' | 'drifting' | 'far' | null;
}

/** Per-section rows. A section with no sentences is not a section (form boilerplate that looked like a heading) and is dropped. */
export function sectionRows(sections: { title: string; summary: AuditSummary }[], voice: AuditSummary): SectionRow[] {
  return sections
    .filter(sec => sec.summary.sentences > 0)
    .map(sec => {
      if (sec.summary.sentences < MIN_SECTION_SENTENCES) return { title: sec.title, sentences: sec.summary.sentences, score: null, band: null };
      const r = styleDistance(sec.summary, voice);
      return { title: sec.title, sentences: sec.summary.sentences, score: r.score, band: r.band };
    });
}

/**
 * The line shown for one flagged sentence: its length and the tells that fired, by their display labels. Used by the
 * style panel and by the review list, so the two can never describe the same sentence differently. Do not reword it.
 */
export function sentenceEvidence(s: SentenceAudit): string {
  return `${s.words} words · ${s.tells.map(t => TELL_PATTERNS[t]?.label ?? t).join(', ') || (s.words > 35 ? 'over 35 words' : 'no specific pattern')}`;
}
