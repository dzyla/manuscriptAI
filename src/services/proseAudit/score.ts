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
 * Weight per metric when scoring a whole document: the strongest tells from the
 * skill's calibration count most. This is a different table from
 * TELL_PATTERNS[...].weight, which ranks individual sentences against each other;
 * the numbers happen to agree today but serve different purposes.
 */
export const WEIGHTS: Record<string, number> = {
  meanWords: 2,
  pctOver35: 2,
  'rather than': 2,
  'not X but/instead': 2,
  'instead of': 1.5,
  semicolon: 1.5,
  'which is appositive': 1.5,
  'is what cleft': 1.5,
  'initial Because': 1,
  'This/That anaphora': 1,
  tricolon: 0.5,
  'throat-clearing': 1,
  'em dash': 1,
  'not only but also': 1.5,
  'paragraph connective': 1,
  'summary flourish': 1,
  'stock vocabulary': 1,
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
