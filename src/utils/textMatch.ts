import { formatCitationGroup } from '../services/citations';

/**
 * Robust text location for AI suggestions.
 *
 * LLMs (especially small local models) misquote manuscript text: curly vs
 * straight quotes, collapsed whitespace, dropped citation markers, em dashes,
 * small paraphrases. The old pipeline used exact indexOf and silently dropped
 * every suggestion that didn't match character-for-character.
 *
 * This module provides a tiered matcher:
 *   1. exact substring
 *   2. normalized substring (unicode punctuation/whitespace + citation markers)
 *   3. anchor-based fuzzy match (prefix/suffix anchors + Levenshtein similarity)
 *
 * plus a ProseMirror document flattener that produces ONE canonical plain-text
 * representation with a char→position map, so the text sent to the LLM, the
 * anchoring, and the editor replacement all agree.
 */

export interface TextSpanMatch {
  start: number;
  end: number;
  matchedText: string;
  method: 'exact' | 'normalized' | 'fuzzy';
}

interface NormalizedText {
  text: string;
  /** map[i] = index in the original string of normalized char i */
  map: number[];
}

const CHAR_MAP: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-',
  '―': '-', '−': '-',
};

const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/;
const UNICODE_SPACE = /[\s\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/;

/** Bracketed citation markers like [3], [1,4], [2-5], [1, 3-6] */
const CITATION_MARKER_RE = /\[\d+(?:\s*[,;–-]\s*\d+)*\]/g;

/**
 * Normalize unicode punctuation and whitespace, keeping a map back to the
 * original string. Optionally removes citation markers so quotes that include
 * or omit them still match.
 */
export function normalizeForMatch(input: string, stripCitations = true): NormalizedText {
  let text = '';
  const map: number[] = [];
  let pendingSpace = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ZERO_WIDTH.test(ch)) continue;
    if (UNICODE_SPACE.test(ch)) {
      pendingSpace = text.length > 0;
      continue;
    }
    if (pendingSpace) {
      text += ' ';
      map.push(i - 1);
      pendingSpace = false;
    }
    if (ch === '…') { // ellipsis → "..."
      text += '...';
      map.push(i, i, i);
      continue;
    }
    text += CHAR_MAP[ch] ?? ch;
    map.push(i);
  }

  if (!stripCitations) return { text, map };

  // Remove citation markers, collapsing any doubled spaces they leave behind.
  let outText = '';
  const outMap: number[] = [];
  let cursor = 0;
  for (const m of text.matchAll(CITATION_MARKER_RE)) {
    const idx = m.index ?? 0;
    let end = idx + m[0].length;
    const start = idx;
    // Absorb one adjacent space so "text [3] more" → "text more" (not "text  more")
    if (text[start - 1] === ' ' && text[end] === ' ') end += 1;
    for (let i = cursor; i < start; i++) { outText += text[i]; outMap.push(map[i]); }
    cursor = end;
  }
  for (let i = cursor; i < text.length; i++) { outText += text[i]; outMap.push(map[i]); }
  return { text: outText, map: outMap };
}

/** Levenshtein distance with early exit once the distance exceeds `limit`. */
function levenshtein(a: string, b: string, limit: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > limit) return limit + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Similarity in [0,1]; strings longer than 600 chars are compared by head+tail. */
function similarity(a: string, b: string): number {
  if (a.length > 600 || b.length > 600) {
    a = a.slice(0, 300) + a.slice(-300);
    b = b.slice(0, 300) + b.slice(-300);
  }
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const limit = Math.ceil(maxLen * 0.3);
  const d = levenshtein(a, b, limit);
  return d > limit ? 0 : 1 - d / maxLen;
}

const FUZZY_MIN_NEEDLE = 20;
const FUZZY_ANCHOR_LEN = 15;
const FUZZY_MIN_SIMILARITY = 0.75;

/**
 * Locate `needle` inside `haystack`, tolerating LLM misquotes.
 * Returns the span in ORIGINAL haystack coordinates plus the actual document
 * text (`matchedText`), which callers should use as the replacement target.
 */
export function findTextSpan(haystack: string, needle: string): TextSpanMatch | null {
  needle = needle.trim();
  if (!needle || !haystack) return null;

  // Tier 1 — exact
  const exactIdx = haystack.indexOf(needle);
  if (exactIdx !== -1) {
    return { start: exactIdx, end: exactIdx + needle.length, matchedText: needle, method: 'exact' };
  }

  const nh = normalizeForMatch(haystack);
  const nn = normalizeForMatch(needle);
  if (!nn.text) return null;

  const mapBack = (normStart: number, normEnd: number): TextSpanMatch | null => {
    if (normStart < 0 || normEnd <= normStart || normEnd > nh.map.length) return null;
    const start = nh.map[normStart];
    const end = nh.map[normEnd - 1] + 1;
    return { start, end, matchedText: haystack.slice(start, end), method: 'normalized' };
  };

  // Tier 2 — normalized substring (case-sensitive, then case-insensitive)
  let idx = nh.text.indexOf(nn.text);
  if (idx === -1) idx = nh.text.toLowerCase().indexOf(nn.text.toLowerCase());
  if (idx !== -1) return mapBack(idx, idx + nn.text.length);

  // Tier 3 — anchor fuzzy match
  if (nn.text.length < FUZZY_MIN_NEEDLE) return null;
  const hayLower = nh.text.toLowerCase();
  const needleLower = nn.text.toLowerCase();
  const prefix = needleLower.slice(0, FUZZY_ANCHOR_LEN);
  const suffix = needleLower.slice(-FUZZY_ANCHOR_LEN);
  const L = needleLower.length;

  let best: { start: number; end: number; sim: number } | null = null;
  const consider = (start: number, end: number) => {
    if (start < 0 || end > nh.text.length || end - start < FUZZY_MIN_NEEDLE) return;
    const sim = similarity(hayLower.slice(start, end), needleLower);
    if (sim >= FUZZY_MIN_SIMILARITY && (!best || sim > best.sim)) {
      best = { start, end, sim };
    }
  };

  // Prefix-anchored candidates: pair with a suffix anchor when present,
  // otherwise fall back to a needle-length window (misquote near the end).
  let from = 0;
  while (true) {
    const i = hayLower.indexOf(prefix, from);
    if (i === -1) break;
    from = i + 1;
    const windowStart = i + Math.max(FUZZY_ANCHOR_LEN, Math.floor(L * 0.6)) - FUZZY_ANCHOR_LEN;
    const windowEnd = i + Math.ceil(L * 1.5);
    let j = hayLower.indexOf(suffix, Math.max(i + 1, windowStart));
    let suffixFound = false;
    while (j !== -1 && j <= windowEnd) {
      suffixFound = true;
      consider(i, j + FUZZY_ANCHOR_LEN);
      j = hayLower.indexOf(suffix, j + 1);
    }
    if (!suffixFound) consider(i, Math.min(hayLower.length, i + L));
  }

  // Suffix-anchored fallback (misquote near the start)
  from = 0;
  while (true) {
    const j = hayLower.indexOf(suffix, from);
    if (j === -1) break;
    from = j + 1;
    consider(j + FUZZY_ANCHOR_LEN - L, j + FUZZY_ANCHOR_LEN);
  }

  if (best) {
    const mapped = mapBack((best as { start: number; end: number }).start, (best as { start: number; end: number }).end);
    if (mapped) {
      // Snap to word boundaries so a fuzzy span never clips mid-word
      let { start, end } = mapped;
      const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);
      while (start > 0 && isWord(haystack[start - 1]) && isWord(haystack[start])) start--;
      while (end < haystack.length && isWord(haystack[end]) && isWord(haystack[end - 1])) end++;
      return { start, end, matchedText: haystack.slice(start, end), method: 'fuzzy' };
    }
  }
  return null;
}

// ─── ProseMirror document flattening ─────────────────────────────────────────

interface FlatSegment {
  flatStart: number;
  flatLen: number;
  pmPos: number;
  /** atom nodes (citations) occupy one PM position regardless of display length */
  atom: boolean;
}

export interface FlatDoc {
  text: string;
  segments: FlatSegment[];
}

/**
 * Flatten a ProseMirror doc into plain text with '\n\n' block separators.
 * Citation atoms contribute their visible "[N]" text so the LLM sees the same
 * text a reader does, mapped back to the atom's single PM position.
 */
export function flattenDoc(doc: any): FlatDoc {
  let text = '';
  const segments: FlatSegment[] = [];
  let prevParent: any = null;

  doc.descendants((node: any, pos: number, parent: any) => {
    const isCitation = node.type?.name === 'citation';
    const isText = node.isText === true;
    if (!isText && !isCitation) return true;

    const t = isText ? (node.text ?? '') : formatCitationGroup(node.attrs?.nums ?? []);
    if (!t) return true;

    if (prevParent !== null && parent !== prevParent) text += '\n\n';
    prevParent = parent;

    segments.push({ flatStart: text.length, flatLen: t.length, pmPos: pos, atom: !isText });
    text += t;
    return true;
  });

  return { text, segments };
}

/**
 * Map a span in FlatDoc.text back to ProseMirror positions.
 * Partially-covered atoms at the edges are excluded (a citation node cannot
 * be split); fully-covered atoms are included in the range.
 */
export function flatSpanToPm(flat: FlatDoc, start: number, end: number): { from: number; to: number } | null {
  if (start >= end) return null;
  const { segments } = flat;

  let from: number | null = null;
  let to: number | null = null;

  for (const seg of segments) {
    const segEnd = seg.flatStart + seg.flatLen;
    if (from === null && segEnd > start) {
      if (seg.flatStart >= end) break;
      if (seg.atom) {
        from = start <= seg.flatStart ? seg.pmPos : seg.pmPos + 1;
      } else {
        from = seg.pmPos + Math.max(0, start - seg.flatStart);
      }
    }
    if (from !== null && segEnd >= end && seg.flatStart < end) {
      if (seg.atom) {
        to = end >= segEnd ? seg.pmPos + 1 : seg.pmPos;
      } else {
        to = seg.pmPos + Math.min(seg.flatLen, end - seg.flatStart);
      }
      break;
    }
    // Span ends in a separator gap after this segment
    if (from !== null && seg.flatStart < end && segEnd < end) {
      to = seg.atom ? seg.pmPos + 1 : seg.pmPos + seg.flatLen;
    }
  }

  if (from === null || to === null || from >= to) return null;
  return { from, to };
}

/**
 * Find `searchText` in a ProseMirror doc, tolerating misquotes.
 * Replaces the old exact-only findTextPosition.
 */
export function findTextPositionRobust(doc: any, searchText: string): { from: number; to: number } | null {
  const flat = flattenDoc(doc);
  const span = findTextSpan(flat.text, searchText);
  if (!span) return null;
  return flatSpanToPm(flat, span.start, span.end);
}
