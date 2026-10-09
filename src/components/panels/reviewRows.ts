import type { Suggestion, SentenceAudit, SuggestionSeverity } from '../../types';
import { findTextSpan } from '../../utils/textMatch';
import { sentenceEvidence } from '../style/styleRows';

export type ReviewKind = 'suggestion' | 'style' | 'grammar';
export type ReviewAction = 'accept' | 'reject' | 'rewrite';

export interface ReviewRow {
  id: string;
  kind: ReviewKind;
  start: number;
  end: number;
  title: string;
  /** H's evidence string for a style row, verbatim. Never paraphrase: four fix rounds made these truthful about which checks fired. */
  evidence: string;
  /** False when the anchor no longer resolves in the document: the row stays visible but its accept/rewrite is disabled. Reject is never gated. */
  canAct: boolean;
  actions: ReviewAction[];
  /** Why the action is unavailable, when that is not already in the evidence. */
  note?: string;
  /** The suggestion's severity, for the filter. Style and grammar rows have none. */
  severity?: SuggestionSeverity;
  /** An advisory suggestion flags a problem and never replaces text: "accept" inserts a note, "reject" dismisses it. */
  advisory?: boolean;
}

export interface ReviewRowsArgs {
  suggestions: Suggestion[];
  flagged: SentenceAudit[];
  /**
   * The app does not hold grammar flags as a list: GrammarChecker draws ProseMirror decorations and exports no accessor, and its
   * positions are document positions, not the plain-text offsets used here. Callers pass [] today; the row kind is supported for when a list exists.
   */
  grammar: { start: number; end: number; message: string }[];
  plainText: string;
  appliedIds: Set<string>;
  /** False while the style audit describes older text than `plainText`: its offsets point somewhere else, so its rows must not act. Default true. */
  styleCurrent?: boolean;
  /** Style rows that cannot be rewritten, keyed by `styleRowId`, with the reason to show. */
  styleBlocked?: Map<string, string>;
}

export const styleRowId = (s: { start: number; end: number }) => `style:${s.start}-${s.end}`;

/**
 * Where a suggestion's text is now, or null when it is gone. Accept finds the text by search (not by offset), so this does too:
 * a row is only live if accepting it would find something. The stored offsets are tried first because they are free.
 */
function anchorOf(plain: string, s: Suggestion): number | null {
  if (!plain || !s.originalText.trim()) return null;
  if (plain.slice(s.startIndex, s.endIndex) === s.originalText) return s.startIndex;
  const exact = plain.indexOf(s.originalText);
  if (exact >= 0) return exact;
  return fuzzyAnchor(plain, s);
}

/**
 * The fuzzy tier is the only expensive one (about 4 ms per miss on 60 KB), so its answer is remembered per (id, quoted text).
 * A hit is re-checked by comparing the text at the remembered place; a miss is reused only for the very same document text.
 * Unchanged stale rows are therefore not re-matched when something else re-renders the list.
 */
const fuzzyCache = new Map<string, { plain: string; start: number | null; matched: string }>();
function fuzzyAnchor(plain: string, s: Suggestion): number | null {
  const key = `${s.id}\u0000${s.originalText}`;
  const hit = fuzzyCache.get(key);
  if (hit) {
    if (hit.start === null ? hit.plain === plain : plain.slice(hit.start, hit.start + hit.matched.length) === hit.matched) return hit.start;
  }
  const m = findTextSpan(plain, s.originalText);
  if (fuzzyCache.size > 2000) fuzzyCache.clear();
  fuzzyCache.set(key, { plain, start: m?.start ?? null, matched: m?.matchedText ?? '' });
  return m?.start ?? null;
}

export function reviewRows(args: ReviewRowsArgs): ReviewRow[] {
  const { suggestions, flagged, grammar, plainText, appliedIds, styleCurrent = true, styleBlocked } = args;

  // Spans already rewritten by an applied suggestion: anything else pointing here is stale.
  const changed = suggestions.filter(s => appliedIds.has(s.id)).map(s => ({ start: s.startIndex, end: s.endIndex }));
  const overlapsChanged = (start: number, end: number) => changed.some(c => start < c.end && end > c.start);

  const keyed: { key: number; row: ReviewRow }[] = [];

  for (const s of suggestions) {
    if (appliedIds.has(s.id)) continue;
    const at = anchorOf(plainText, s);
    const intact = at !== null;
    const advisory = s.kind === 'advisory';
    keyed.push({
      key: at ?? s.startIndex,
      row: {
        id: `suggestion:${s.id}`,
        kind: 'suggestion',
        start: s.startIndex,
        end: s.endIndex,
        title: s.agent,
        evidence: s.explanation,
        canAct: intact && !overlapsChanged(s.startIndex, s.endIndex),
        actions: advisory || s.suggestedText ? ['accept', 'reject'] : ['reject'],
        ...(intact ? {} : { note: 'The text this refers to has changed. It can be dismissed but not applied.' }),
        ...(s.severity ? { severity: s.severity } : {}),
        ...(advisory ? { advisory: true } : {}),
      },
    });
  }

  for (const f of flagged) {
    const id = styleRowId(f);
    const evidence = sentenceEvidence(f);
    // An applied suggestion's offsets describe the text as it was; they say nothing about a flag measured afterwards.
    const overlapped = !styleCurrent && overlapsChanged(f.start, f.end);
    const blocked = styleBlocked?.get(id);
    keyed.push({
      key: f.start,
      row: {
        id,
        kind: 'style',
        start: f.start,
        end: f.end,
        title: evidence,
        evidence: overlapped ? `${evidence} — this sentence has already changed since it was measured` : evidence,
        canAct: styleCurrent && !overlapped && !blocked,
        actions: ['rewrite'],
        ...(!styleCurrent && !overlapped ? { note: 'Re-measuring after your edit.' } : {}),
        ...(blocked && styleCurrent ? { note: blocked } : {}),
      },
    });
  }

  for (const g of grammar) {
    keyed.push({
      key: g.start,
      row: {
        id: `grammar:${g.start}-${g.end}`,
        kind: 'grammar',
        start: g.start,
        end: g.end,
        title: 'Grammar',
        evidence: g.message,
        canAct: !overlapsChanged(g.start, g.end),
        actions: ['accept', 'reject'],
      },
    });
  }

  return keyed.sort((a, b) => a.key - b.key || a.row.kind.localeCompare(b.row.kind)).map(k => k.row);
}
