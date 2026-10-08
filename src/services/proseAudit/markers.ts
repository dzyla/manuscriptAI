/**
 * Citation markers as they appear in flattenDoc text: `[3]`, `[3-5]`, `[3,4]`. A citation atom renders as
 * `formatCitationGroup(nums)`, so the marker the model sees for an atom equals the atom's display exactly.
 * One tokenizer is used on every side (original, rewrite, apply) so a marker nested in a longer typed
 * marker cannot be split differently in two places.
 */
const MARKER_SOURCE = '\\[\\d+(?:\\s*[,;–-]\\s*\\d+)*\\]';

export interface MarkerToken { raw: string; norm: string; index: number }

/** "[3 – 5]" and "[3-5]" are the same marker. */
export const normalizeMarker = (m: string): string => m.replace(/\s+/g, '').replace(/–/g, '-').replace(/;/g, ',');

export function markerTokens(text: string): MarkerToken[] {
  return [...text.matchAll(new RegExp(MARKER_SOURCE, 'g'))].map(m => ({ raw: m[0], norm: normalizeMarker(m[0]), index: m.index ?? 0 }));
}

function counts(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of markerTokens(text)) out.set(t.norm, (out.get(t.norm) ?? 0) + 1);
  return out;
}

/** Multiset comparison: the rewrite must carry exactly the markers the original has (order is free). */
export function compareMarkers(original: string, rewrite: string): { ok: boolean; missing: string[]; extra: string[] } {
  const a = counts(original);
  const b = counts(rewrite);
  const missing: string[] = [];
  const extra: string[] = [];
  for (const [k, n] of a) for (let i = 0; i < n - (b.get(k) ?? 0); i++) missing.push(k);
  for (const [k, n] of b) for (let i = 0; i < n - (a.get(k) ?? 0); i++) extra.push(k);
  return { ok: !missing.length && !extra.length, missing, extra };
}
