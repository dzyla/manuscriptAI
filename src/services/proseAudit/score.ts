import type { AuditSummary } from '../../types';
import { MACHINE_REFERENCE } from './profile';
import { TELL_PATTERNS } from './patterns';

export interface MetricDeviation {
  metric: string;
  label: string;
  voice: number;
  draft: number;
  /** 0 = at the author's voice, 1 = at the machine reference */
  deviation: number;
}

/**
 * Weight per metric when scoring a whole document. This is a different table from
 * TELL_PATTERNS[...].weight, which ranks individual sentences against each other and
 * keeps full weight for every tell; that is where the tells below are most useful to
 * the author.
 *
 * The first block is the metrics backed by the skill's calibration table, weighted by how strong a tell each is. The second block,
 * the nine untabulated tells, is deliberately discounted to 0.5: no calibration
 * measurement backs their scale (their machine-side reference values are chosen
 * thresholds, see profile.ts), so they must not dominate the document score.
 */
export const WEIGHTS: Record<string, number> = {
  // calibrated
  meanWords: 2,
  pctOver35: 2,
  'rather than': 2,
  semicolon: 1.5,
  'which is appositive': 1.5,
  'is what cleft': 1.5,
  'initial Because': 1,
  // tricolon is measured and shown but NOT scored: the author's own unassisted R01 prose measures 11.1 per 100, which all but
  // saturates the metric's estimated machine value of 12, so it cannot discriminate (see profile.ts).
  // untabulated: evidential discount
  'not X but/instead': 0.5,
  'instead of': 0.5,
  'This/That anaphora': 0.5,
  'throat-clearing': 0.5,
  'em dash': 0.5,
  'not only but also': 0.5,
  'paragraph connective': 0.5,
  'summary flourish': 0.5,
  'stock vocabulary': 0.5,
};

/**
 * Minimum scale (in the metric's own units) over which drift is measured. 9 and 26
 * are the rounded calibration spans for meanWords (26.8 - 17.6) and pctOver35
 * (27 - 1); every other metric is a per-100-sentences rate and uses 5 (a chosen
 * floor, not measured). The floor keeps the scale from collapsing when an author's
 * own voice sits near the machine reference.
 */
const FALLBACK_SPAN: Record<string, number> = { meanWords: 9, pctOver35: 26 };
const DEFAULT_SPAN = 5;

/** Per-metric drift is clamped at 1.5 so one runaway metric cannot dominate the mean (chosen, not measured). */
const MAX_DEVIATION = 1.5;

function deviation(metric: string, draft: number, voice: number, machine: number): number {
  const span = Math.max(machine - voice, FALLBACK_SPAN[metric] ?? DEFAULT_SPAN);
  // Math.max(0, ...): drift BELOW the author's voice (shorter sentences, fewer tells)
  // deliberately scores 0. The score measures drift toward the machine pattern only.
  return Math.max(0, Math.min(MAX_DEVIATION, (draft - voice) / span));
}

/** A missing or non-finite value (e.g. a stale profile restored from storage) counts as 0. */
function value(s: AuditSummary, metric: string): number {
  const v = metric === 'meanWords' ? s.meanWords : metric === 'pctOver35' ? s.pctOver35 : s.rates?.[metric];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

const LABELS: Record<string, string> = {
  meanWords: 'mean sentence length',
  pctOver35: 'sentences over 35 words',
};

function label(metric: string): string {
  return LABELS[metric] ?? TELL_PATTERNS[metric]?.label ?? metric;
}

/** Band cut-offs on the 0-100 score (chosen, not measured). */
const CLOSE_BELOW = 25;
const FAR_ABOVE = 50;

export function styleDistance(
  draft: AuditSummary,
  voice: AuditSummary,
): { score: number; band: 'close' | 'drifting' | 'far'; deviations: MetricDeviation[] } {
  const deviations: MetricDeviation[] = [];
  let weighted = 0;
  let total = 0;
  for (const [metric, weight] of Object.entries(WEIGHTS)) {
    const d = value(draft, metric);
    const v = value(voice, metric);
    const m = value(MACHINE_REFERENCE, metric);
    const dev = deviation(metric, d, v, m);
    deviations.push({ metric, label: label(metric), voice: v, draft: d, deviation: Math.round(dev * 100) / 100 });
    weighted += dev * weight;
    total += weight;
  }
  const raw = total ? weighted / total : 0;
  const score = Math.round(Math.min(100, raw * 100));
  deviations.sort((a, b) => b.deviation - a.deviation);
  return { score, band: score < CLOSE_BELOW ? 'close' : score <= FAR_ABOVE ? 'drifting' : 'far', deviations };
}
