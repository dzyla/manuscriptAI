import { useMemo, useRef } from 'react';

export interface OutlineItem { level: number; text: string }

/** Headings (H2/H3) of the manuscript HTML, in document order. Lifted unchanged from the old outline tab. */
export function deriveOutline(html: string): OutlineItem[] {
  if (!html) return [];
  const re = /<h([23])[^>]*>(.*?)<\/h[23]>/gi;
  return [...html.matchAll(re)].map(m => ({ level: parseInt(m[1]), text: m[2].replace(/<[^>]*>/g, '').trim() }));
}

/** Word count per H2 section, keyed by heading text (a repeated heading keeps the later count, as before). */
export function deriveH2WordCounts(html: string): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!html) return counts;
  const h2Matches = [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/gi)];
  h2Matches.forEach((m, i) => {
    const title = m[1].replace(/<[^>]*>/g, '').trim();
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < h2Matches.length ? (h2Matches[i + 1].index ?? html.length) : html.length;
    const text = html.slice(start, end).replace(/<[^>]*>/g, ' ');
    counts[title] = text.split(/\s+/).filter(w => w.length > 0).length;
  });
  return counts;
}

const sameOutline = (a: OutlineItem[], b: OutlineItem[]) => a.length === b.length && a.every((x, i) => x.level === b[i].level && x.text === b[i].text);
const sameCounts = (a: Record<string, number>, b: Record<string, number>) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every(k => a[k] === b[k]);
};

/**
 * Outline and per-section word counts for the open document. The Write panel stays mounted while another task is open, so
 * a keystroke that changes neither the headings nor the counts must hand it the same objects (it then skips re-rendering).
 */
export function useOutline(html: string): { outline: OutlineItem[]; wordCounts: Record<string, number> } {
  const prev = useRef<{ outline: OutlineItem[]; wordCounts: Record<string, number> } | null>(null);
  return useMemo(() => {
    const outline = deriveOutline(html), wordCounts = deriveH2WordCounts(html);
    const p = prev.current;
    const next = {
      outline: p && sameOutline(p.outline, outline) ? p.outline : outline,
      wordCounts: p && sameCounts(p.wordCounts, wordCounts) ? p.wordCounts : wordCounts,
    };
    prev.current = next;
    return p && p.outline === next.outline && p.wordCounts === next.wordCounts ? p : next;
  }, [html]);
}
