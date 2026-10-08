export type FidelityCategory = 1 | 2 | 3 | 4;

export type FeatureKey =
  // category 1 — editable, round-trippable
  | 'paragraph' | 'run' | 'paragraphStyle' | 'characterStyle' | 'heading' | 'list' | 'table'
  | 'mergedCell' | 'inlineImage' | 'floatingImageSquare' | 'caption' | 'pageBreak' | 'hyperlink'
  | 'pageSetup' | 'trackedChange' | 'formatChange' | 'comment' | 'nativeCitation' | 'googleWrapper'
  // category 2 — approximated, semantically preserved
  | 'floatingImageOther' | 'tabStops' | 'keepRules' | 'tableBorders' | 'complexNumbering' | 'externalCitation'
  | 'externalBibliography' | 'inferredHeading'
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
  externalCitation: 2, externalBibliography: 2, inferredHeading: 2,
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

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export function summarizeReport(r: ImportReport): string {
  const parts: string[] = [];
  if (r.pageCount) parts.push(plural(r.pageCount, 'page'));
  const c = r.counts;
  const revisions = (c.trackedChange ?? 0) + (c.formatChange ?? 0);
  if (revisions) parts.push(plural(revisions, 'tracked change'));
  if (c.comment) parts.push(plural(c.comment, 'comment'));
  if (c.list) parts.push(plural(c.list, 'list'));
  const cites = (c.nativeCitation ?? 0) + (c.externalCitation ?? 0);
  if (cites) parts.push(plural(cites, 'citation'));
  if (c.externalBibliography) parts.push(plural(c.externalBibliography, 'bibliography', 'bibliographies'));
  if (r.byCategory[3]) parts.push(`${r.byCategory[3]} preserved read-only`);
  if (r.warnings.length) parts.push(plural(r.warnings.length, 'warning'));
  return parts.length ? `Imported ${parts.join(' · ')}` : 'Imported document';
}
