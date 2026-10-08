import { splitSentences } from '../detectors';
import type { AuditMetrics, AuditSummary, SentenceAudit } from '../../types';
import { PATTERN_NAMES, TELL_PATTERNS, countMatches } from './patterns';

/** A line that reads as a heading: short, no terminal punctuation. */
function isHeadingLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  return t.split(/\s+/).length <= 8 && !/[.!?;:]$/.test(t);
}

const REFERENCE_HEADING = /^(?:references|bibliography|literature cited|works cited)\s*$/i;

/**
 * Prose regions of the text, with headings and anything after a References
 * heading removed. Offsets are preserved by blanking excluded spans with spaces,
 * so sentence offsets still index the caller's original string.
 */
export function prosePortion(text: string): string {
  const lines = text.split('\n');
  let cut = false;
  let out = '';
  for (const line of lines) {
    const blank = ' '.repeat(line.length);
    if (REFERENCE_HEADING.test(line.trim())) cut = true;
    out += (cut || isHeadingLine(line) ? blank : line) + '\n';
  }
  return out.slice(0, text.length);
}

function summarize(text: string, sentences: SentenceAudit[]): AuditSummary {
  const counts: Record<string, number> = {};
  const rates: Record<string, number> = {};
  const n = sentences.length;
  for (const name of PATTERN_NAMES) {
    counts[name] = countMatches(TELL_PATTERNS[name], text);
    rates[name] = n ? Math.round((1000 * counts[name]) / n) / 10 : 0;
  }
  const lens = sentences.map(s => s.words);
  const mean = n ? lens.reduce((a, b) => a + b, 0) / n : 0;
  const variance = n ? lens.reduce((a, b) => a + (b - mean) ** 2, 0) / n : 0;
  return {
    sentences: n,
    meanWords: Math.round(mean * 10) / 10,
    pctOver35: n ? Math.round((1000 * lens.filter(w => w > 35).length) / n) / 10 : 0,
    lengthCv: mean ? Math.round((Math.sqrt(variance) / mean) * 100) / 100 : 0,
    counts,
    rates,
  };
}

function auditSentences(prose: string): SentenceAudit[] {
  return splitSentences(prose)
    .filter(s => s.text.split(/\s+/).filter(Boolean).length > 3)
    .map(s => {
      const tells: string[] = [];
      let weighted = 0;
      for (const name of PATTERN_NAMES) {
        const n = countMatches(TELL_PATTERNS[name], s.text);
        if (n > 0) {
          tells.push(name);
          weighted += n * TELL_PATTERNS[name].weight;
        }
      }
      const words = s.text.split(/\s+/).filter(Boolean).length;
      return { start: s.start, end: s.start + s.text.length, words, tells, severity: words + 8 * weighted };
    });
}

/** Top-level headings split the document into sections for per-section reporting. */
function splitSections(text: string): { title: string; start: number; end: number }[] {
  const out: { title: string; start: number; end: number }[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    if (isHeadingLine(line) && !REFERENCE_HEADING.test(line.trim())) {
      if (out.length) out[out.length - 1].end = offset;
      out.push({ title: line.trim(), start: offset + line.length + 1, end: text.length });
    }
    offset += line.length + 1;
  }
  return out;
}

export function auditText(text: string): AuditMetrics {
  const prose = prosePortion(text);
  const sentences = auditSentences(prose);
  const sections = splitSections(text).map(sec => {
    const slice = prose.slice(sec.start, sec.end);
    const secSentences = sentences.filter(s => s.start >= sec.start && s.end <= sec.end);
    return { title: sec.title, summary: summarize(slice, secSentences) };
  });
  return { summary: summarize(prose, sentences), sentences, sections };
}

export function worstSentences(m: AuditMetrics, k = 10): SentenceAudit[] {
  return [...m.sentences].sort((a, b) => b.severity - a.severity).slice(0, k);
}
