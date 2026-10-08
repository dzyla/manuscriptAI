export type FidelityCategory = 1 | 2 | 3 | 4;

export type FeatureKey =
  // category 1 — editable, round-trippable
  | 'paragraph' | 'run' | 'paragraphStyle' | 'characterStyle' | 'heading' | 'list' | 'table'
  | 'mergedCell' | 'inlineImage' | 'floatingImageSquare' | 'caption' | 'pageBreak' | 'hyperlink'
  | 'pageSetup' | 'trackedChange' | 'formatChange' | 'comment' | 'nativeCitation' | 'googleWrapper'
  // category 2 — approximated, semantically preserved
  | 'floatingImageOther' | 'tabStops' | 'keepRules' | 'tableBorders' | 'complexNumbering' | 'externalCitation'
  | 'externalBibliography' | 'inferredHeading' | 'tableLayout'
  // category 3 — opaque, preserved while untouched
  | 'equation' | 'footnoteRef' | 'endnoteRef' | 'contentControl' | 'bookmark' | 'unknownField'
  | 'oleObject' | 'sectionBreak'
  // category 4 — unsupported
  | 'activeX' | 'textBox' | 'smartArt';

export const FIDELITY: Record<FeatureKey, FidelityCategory> = {
  paragraph: 1, run: 1, paragraphStyle: 1, characterStyle: 1, heading: 1, list: 1, table: 1,
  mergedCell: 1, inlineImage: 1, floatingImageSquare: 1, caption: 1, pageBreak: 1, hyperlink: 1,
  pageSetup: 1, trackedChange: 1, formatChange: 1, comment: 1, nativeCitation: 1, googleWrapper: 1,
  floatingImageOther: 2, tabStops: 2, keepRules: 2, tableBorders: 2, complexNumbering: 2,
  externalCitation: 2, externalBibliography: 2, inferredHeading: 2, tableLayout: 2,
  equation: 3, footnoteRef: 3, endnoteRef: 3, contentControl: 3, bookmark: 3, unknownField: 3,
  oleObject: 3, sectionBreak: 3,
  activeX: 4, textBox: 4, smartArt: 4,
};

const UNSUPPORTED_MESSAGE: Partial<Record<FeatureKey, string>> = {
  activeX: 'ActiveX controls are not supported and will not be exported.',
  textBox: 'Text box layout is approximated; its text was kept as plain paragraphs.',
  smartArt: 'SmartArt is not editable; it is kept only if its XML is self-contained.',
};

export interface ImportWarning {
  feature: FeatureKey | 'part';
  message: string;
  category: FidelityCategory;
}

export interface ImportReport {
  counts: Partial<Record<FeatureKey, number>>;
  byCategory: Record<FidelityCategory, number>;
  warnings: ImportWarning[];
  pageCount?: number;
  /**
   * Set by the importer once the document is read: how many of the category-3 atoms (`byCategory[3]`) are pieces that already have a
   * count of their own, so the summary does not describe the same pieces twice. A tracked change is one atom; a comment is up to
   * three (where its range starts, where it ends, and its reference), so 52 comments are 152 anchors; a reference-manager citation
   * or bibliography is the four pieces of its field (begin, code, separator, end).
   */
  described?: { trackedChange: number; commentAnchor: number; citationField: number };
  /** Comments that are in the file but have no anchor in the main text (a footnote or header anchor, or none); set only when there are any. */
  commentsNotInText?: number;
  /**
   * Set by the importer when the document has pictures: how many there are and how many were paired with a caption paragraph
   * (`ImportResult.figures` has the pairs). `images` counts TOP-LEVEL pictures only: one inside a table cell is not paired at import. Not `counts.caption`, which counts paragraphs in Word's Caption style: most grants
   * never use that style and label their captions "Fig. N." by hand, so the two numbers differ and neither implies the other.
   */
  figures?: { images: number; captioned: number };
}

export function createReport(): ImportReport {
  return { counts: {}, byCategory: { 1: 0, 2: 0, 3: 0, 4: 0 }, warnings: [] };
}

export function recordFeature(r: ImportReport, key: FeatureKey, n = 1): void {
  if (n <= 0) return;
  r.counts[key] = (r.counts[key] ?? 0) + n;
  const cat = FIDELITY[key];
  r.byCategory[cat] += n;
  if (cat === 4 && !r.warnings.some(w => w.feature === key)) {
    r.warnings.push({ feature: key, category: 4, message: UNSUPPORTED_MESSAGE[key] ?? `${key} is not supported.` });
  }
}

export function addWarning(r: ImportReport, feature: FeatureKey | 'part', message: string, category: FidelityCategory = 4): void {
  r.warnings.push({ feature, message, category });
}

/**
 * `"1 word"` / `"3 words"`: the count AND the noun. The one definition for report and evidence text (ImportReportDialog has a
 * differently-shaped helper of its own, `nounFor`, which returns the noun alone).
 */
export const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/**
 * How many category-3 atoms are kept but neither edited nor already counted under a heading of their own (tracked changes, comment
 * anchors, citation fields): equations, footnote markers, fields, content controls and so on. The "preserved read-only" figure.
 *
 * A BARE SUBTRACTION, deliberately: `described` is the part of `byCategory[3]` that has a count of its own, so it can never exceed it.
 * If it ever does, the figure goes negative and shows, which is better than a `Math.max(0, ...)` that hides the surplus. The clamp was
 * once here and concealed exactly such a case: a citation nested in a citation was counted twice (8 pieces reported as 12 against an
 * atom total of 11), the clamp turned the PAGEREF field's 3 pieces into "0 other preserved read-only", and the author was never told
 * they existed. A negative figure now shows in the dialog (`reportRows` pushes on `!== 0`) and in the summary. The invariants that
 * keep it from happening are asserted where the atoms are counted: `byCategory[3] === atoms.length` (private-fixtures.test.ts) and
 * `=== atoms.length + counts.sectionBreak` (readDocx.test.ts, opaque.docx); the PAGEREF case is in readDocx.test.ts.
 */
export function preservedReadOnly(r: ImportReport): { count: number; hasDescribed: boolean } {
  const described = r.described ? r.described.trackedChange + r.described.commentAnchor + r.described.citationField : 0;
  return { count: r.byCategory[3] - described, hasDescribed: described > 0 };
}

export function summarizeReport(r: ImportReport): string {
  const parts: string[] = [];
  if (r.pageCount) parts.push(plural(r.pageCount, 'page'));
  const c = r.counts;
  const revisions = (c.trackedChange ?? 0) + (c.formatChange ?? 0);
  if (revisions) parts.push(plural(revisions, 'tracked change'));
  if (c.comment) parts.push(plural(c.comment, 'comment') + ((r.commentsNotInText ?? 0) >= c.comment ? ' (none anchored in the text)' : ''));
  if (c.list) parts.push(plural(c.list, 'list'));
  const cites = (c.nativeCitation ?? 0) + (c.externalCitation ?? 0);
  if (cites) parts.push(plural(cites, 'citation'));
  if (c.externalBibliography) parts.push(plural(c.externalBibliography, 'bibliography', 'bibliographies'));
  // The atoms that are tracked changes, comment anchors or the pieces of a citation field are the ones counted above; what is left is everything else the
  // document holds that the editor keeps but cannot edit (equations, footnote markers, fields, content controls, ...).
  const { count: other, hasDescribed } = preservedReadOnly(r);
  if (other) parts.push(`${other} ${hasDescribed ? 'other ' : ''}preserved read-only`);
  if (r.warnings.length) parts.push(plural(r.warnings.length, 'warning'));
  return parts.length ? `Imported ${parts.join(' · ')}` : 'Imported document';
}
