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

/** Weight per metric: the strongest tells from the skill's calibration count most. */
const WEIGHTS: Record<string, number> = {
  meanWords: 2,
  pctOver35: 2,
  'rather than': 2,
  'not X but/instead': 2,
  'instead of': 1,
  semicolon: 1.5,
  'which is appositive': 1.5,
  'is what cleft': 1.5,
  'initial Because': 1,
  'This/That anaphora': 1,
  tricolon: 0.5,
  'throat-clearing': 1,
  'em dash': 1,
  'not only but also': 1,
  'paragraph connective': 1,
  'summary flourish': 1,
  'stock vocabulary': 1,
};

/** Fallback scale when the machine reference is not above the voice value. */
const FALLBACK_SPAN: Record<string, number> = { meanWords: 9, pctOver35: 26 };

function deviation(metric: string, draft: number, voice: number, machine: number): number {
  const span = machine > voice ? machine - voice : (FALLBACK_SPAN[metric] ?? Math.max(voice, 5));
  return Math.max(0, Math.min(1.5, (draft - voice) / span));
}

function value(s: AuditSummary, metric: string): number {
  if (metric === 'meanWords') return s.meanWords;
  if (metric === 'pctOver35') return s.pctOver35;
  return s.rates[metric] ?? 0;
}

const LABELS: Record<string, string> = {
  meanWords: 'mean sentence length',
  pctOver35: 'sentences over 35 words',
};

function label(metric: string): string {
  return LABELS[metric] ?? TELL_PATTERNS[metric]?.label ?? metric;
}

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
    const dev = deviation(metric, d, v, value(MACHINE_REFERENCE, metric));
    deviations.push({ metric, label: label(metric), voice: v, draft: d, deviation: Math.round(dev * 100) / 100 });
    weighted += dev * weight;
    total += weight;
  }
  const raw = total ? weighted / total : 0;
  const score = Math.round(Math.min(100, raw * 100));
  deviations.sort((a, b) => b.deviation - a.deviation);
  return { score, band: score < 25 ? 'close' : score <= 50 ? 'drifting' : 'far', deviations };
}
