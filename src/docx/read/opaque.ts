/**
 * Minimal opaque passthrough: capture an element verbatim, store it as a fragment and return an
 * atom that references it. Task 10 owns the full per-kind classification and the import report; this
 * exists now so that nothing the body readers do not model is ever dropped.
 */
import type { JSONContent } from '@tiptap/core';
import { addWarning, recordFeature, type FeatureKey, type ImportReport } from '../fidelity';
import { captureFragment, captureShell } from '../preserve/xml';
import { warnOnce, type ReadContext } from './context';
import { M_NS, W_NS, firstW, wAttr } from './ooxml';

const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

/**
 * Classify a complex field by its WHOLE instruction (every w:instrText between `begin` and
 * `separate`, concatenated: Word and the managers split an instruction across runs at arbitrary
 * points, so the manager token can land in a later piece than `ADDIN`). Any ADDIN field belongs to
 * a third-party add-in (Zotero, Mendeley, EndNote, Paperpile, ...) and is treated as a citation, or
 * as a bibliography when it names one. Word's own CITATION / BIBLIOGRAPHY fields are the same two kinds.
 */
export function classifyField(instruction: string): 'externalCitation' | 'externalBibliography' | null {
  const instr = instruction.trim();
  if (/^ADDIN\b/i.test(instr)) {
    // Only the manager token (up to the payload): the payload is the cited items' own metadata, whose titles
    // may say "bibliography" or "bibliometric" without the field being one.
    const token = instr.split(/[{<]/, 1)[0];
    return /BIBL|REFLIST/i.test(token) ? 'externalBibliography' : 'externalCitation';
  }
  if (/^BIBLIOGRAPHY\b/i.test(instr)) return 'externalBibliography';
  if (/^CITATION\b/i.test(instr)) return 'externalCitation';
  return null;
}

/** Also raised by `readDocx` for review state it finds outside the paragraphs, so the author is told the same thing wherever it sits. */
export const COMMENT_WARNING = 'Comments are kept as read-only anchors for now; their text and replies are not shown or editable here. They stay in the file.';
export const TRACKED_CHANGE_WARNING = 'Tracked changes are kept as read-only pieces for now; their text is not shown or editable here.';

const FIELD_WARNING =
  'Reference-manager fields (Zotero, Mendeley, EndNote, Paperpile, ...) are kept as read-only pieces. Where a field is split, the text it displays is ordinary editable text between those pieces, so editing a paragraph that holds one can break the field. Change citations and bibliographies in the reference manager instead.';

/** Record a classified field and make it visible: report count, one warning, and a chip label that names it. */
export function recordField(key: 'externalCitation' | 'externalBibliography', ctx: ReadContext, codeAtoms: JSONContent[]): void {
  recordFeature(ctx.report, key);
  // One message for both kinds: a document with citations AND a bibliography is told once, not twice.
  if (!ctx.report.warnings.some(w => w.message === FIELD_WARNING)) addWarning(ctx.report, key, FIELD_WARNING, 2);
  const label = key === 'externalCitation' ? 'citation field code' : 'bibliography field code';
  for (const a of codeAtoms) if (a.attrs) a.attrs.label = label;
}

/**
 * Remember how many comment ids are counted so far; the returned function forgets every id counted after that (used when a
 * paragraph's or table's atoms are withdrawn). O(1) to take: ids are kept in counting order, so only the restore walks the set.
 */
export function snapshotCommentIds(report: ImportReport): () => void {
  const before = seenComments.get(report)?.size ?? 0;
  return () => {
    const seen = seenComments.get(report);
    if (!seen || seen.size <= before) return;
    [...seen].slice(before).forEach(id => seen.delete(id));
  };
}

/** Comment ids already counted, so one comment (start, end and reference) is one `comment`. */
const seenComments = new WeakMap<ImportReport, Set<string>>();

export interface OpaqueOptions {
  /** Emit an `opaqueBlock` instead of an `opaqueInline`. */
  block?: boolean;
  /**
   * The run that holds `el`. The fragment is then a copy of that run containing only its w:rPr and
   * `el`, so the atom keeps the run's formatting (footnote-reference superscript, field colour, ...).
   */
  within?: Element;
}

export function readOpaque(el: Element, ctx: ReadContext, kind: FeatureKey, label: string, opts: OpaqueOptions = {}): JSONContent {
  const fragmentId = ctx.nextId();
  let fragment;
  if (opts.within) {
    const rPr = firstW(opts.within, 'rPr');
    fragment = captureShell(opts.within, rPr ? [rPr, el] : [el]);
  } else {
    fragment = captureFragment(el);
  }
  ctx.preservation.fragments[fragmentId] = fragment;
  recordFeature(ctx.report, kind);
  recordSemantic(el, classifyOpaque(el), ctx);
  return { type: opts.block ? 'opaqueBlock' : 'opaqueInline', attrs: { kind, label, fragmentId } };
}

export interface OpaqueClass {
  /** What the atom is (its own `kind` attribute, category 3). */
  kind: FeatureKey;
  label: string;
  /** What the author should be told the document contains, when that differs from `kind`. */
  semantic?: FeatureKey;
}

/**
 * Record the semantic key next to the atom's own category-3 record, so the import summary can say
 * "32 tracked changes, 59 comments, 22 citations" instead of one opaque total.
 */
function recordSemantic(el: Element, c: OpaqueClass, ctx: ReadContext): void {
  if (!c.semantic) return;
  if (c.semantic === 'comment') {
    const id = wAttr(el, 'id') ?? '';
    const seen = seenComments.get(ctx.report) ?? new Set<string>();
    seenComments.set(ctx.report, seen);
    if (id && seen.has(id)) return;
    if (id) seen.add(id);
  }
  recordFeature(ctx.report, c.semantic);
  if (c.semantic === 'comment') {
    warnOnce(ctx.report, 'comment', COMMENT_WARNING, 3);
  }
  if (c.semantic === 'trackedChange') {
    warnOnce(ctx.report, 'trackedChange', TRACKED_CHANGE_WARNING, 3);
  }
}

/** What an element the body readers do not model is called in the report and on its chip. */
export function classifyOpaque(el: Element): OpaqueClass {
  const ns = el.namespaceURI;
  const name = el.localName;
  if (ns === M_NS && (name === 'oMath' || name === 'oMathPara')) return { kind: 'equation', label: 'equation' };
  if (ns === W_NS) {
    switch (name) {
      case 'footnoteReference': return { kind: 'footnoteRef', label: 'footnote' };
      case 'endnoteReference': return { kind: 'endnoteRef', label: 'endnote' };
      case 'sdt': return { kind: 'contentControl', label: 'content control' };
      case 'bookmarkStart':
      case 'bookmarkEnd': return { kind: 'bookmark', label: 'bookmark' };
      case 'fldChar': {
        const t = wAttr(el, 'fldCharType');
        return { kind: 'unknownField', label: t === 'begin' ? 'field start' : t === 'separate' ? 'field separator' : t === 'end' ? 'field end' : 'field' };
      }
      case 'instrText':
      case 'delInstrText': return { kind: 'unknownField', label: 'field code' };
      case 'fldSimple': return { kind: 'unknownField', label: 'field' };
      case 'object':
      case 'control': return { kind: 'oleObject', label: 'embedded object' };
      case 'ins':
      case 'del':
      case 'moveFrom':
      case 'moveTo': return { kind: 'unknownField', label: 'tracked change', semantic: 'trackedChange' };
      case 'commentRangeStart':
      case 'commentRangeEnd':
      case 'commentReference': return { kind: 'unknownField', label: 'comment anchor', semantic: 'comment' };
      case 'drawing': return classifyDrawing(el);
      case 'pict': return { kind: 'unknownField', label: 'picture' };
      default: break;
    }
  }
  return { kind: 'unknownField', label: el.localName };
}

/**
 * What a `w:drawing` that did not become an image node is. SmartArt is category 4 (kept, not editable); a chart, a shape and a
 * text box are named on their chip. Every one of them is kept verbatim.
 */
function classifyDrawing(el: Element): OpaqueClass {
  const uri = el.getElementsByTagNameNS(A_NS, 'graphicData')[0]?.getAttribute('uri') ?? '';
  if (/\/diagram$/.test(uri)) return { kind: 'unknownField', label: 'SmartArt', semantic: 'smartArt' };
  if (/\/chart(?:$|\/)/.test(uri)) return { kind: 'unknownField', label: 'chart' };
  if (/wordprocessing(?:Shape|Group|Canvas)$/.test(uri)) {
    return { kind: 'unknownField', label: el.getElementsByTagNameNS(W_NS, 'txbxContent').length ? 'text box' : 'shape' };
  }
  return { kind: 'unknownField', label: 'drawing' };
}
