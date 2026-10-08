import type { AuditSummary } from '../../types';
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
  };
}
