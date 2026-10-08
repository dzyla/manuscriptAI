import type { Node as PMNode } from '@tiptap/pm/model';
import { flaggedSentences } from '../../services/proseAudit/metrics';
import { flattenDoc, flatSpanToPm } from '../../utils/textMatch';
import type { AuditMetrics, SentenceAudit } from '../../types';

/** Metrics together with the exact editor text (flattenDoc offsets) they were computed from. */
export interface StyleAuditSnapshot {
  metrics: AuditMetrics;
  text: string;
}

/**
 * True only if sentence offsets from `audit` still index the document: i.e. the editor text is
 * unchanged since the audit. Offsets from a different text would be drawn at shifted positions.
 */
export function auditMatchesDoc(audit: StyleAuditSnapshot | null, currentText: string | undefined): audit is StyleAuditSnapshot {
  return !!audit && currentText !== undefined && currentText === audit.text;
}

/** Sentences to hand to the editor for highlighting: empty unless drawing is on and the audit is current. */
export function sentencesToDraw(
  audit: StyleAuditSnapshot | null,
  currentText: string | undefined,
  draw: boolean,
  k = 12,
): SentenceAudit[] {
  return draw && auditMatchesDoc(audit, currentText) ? flaggedSentences(audit.metrics, k) : [];
}

/** Map a span in flattenDoc text offsets to document positions, or null when it is out of range / unmappable. */
export function flatRangeToPm(doc: PMNode, start: number, end: number): { from: number; to: number } | null {
  const flat = flattenDoc(doc);
  if (start < 0 || end > flat.text.length || end <= start) return null;
  return flatSpanToPm(flat, start, end);
}
