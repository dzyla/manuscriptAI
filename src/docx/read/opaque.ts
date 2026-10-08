/**
 * Minimal opaque passthrough: capture an element verbatim, store it as a fragment and return an
 * atom that references it. Task 10 owns the full per-kind classification and the import report; this
 * exists now so that nothing the body readers do not model is ever dropped.
 */
import type { JSONContent } from '@tiptap/core';
import { recordFeature, type FeatureKey, type ImportReport } from '../fidelity';
import { captureFragment, captureShell } from '../preserve/xml';
import { warnOnce, type ReadContext } from './context';
import { M_NS, W_NS, firstW, wAttr } from './ooxml';

/** Instructions written by reference managers (Zotero, Mendeley, EndNote, Paperpile, ...) and Word's own citation fields. */
const CITATION_FIELD = /^\s*(ADDIN\s+(ZOTERO|CSL_CITATION|EN\.CITE|MENDELEY|PAPERPILE|F1000|PAPERS|READCUBE)|CITATION\b|BIBLIOGRAPHY\b)/i;

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
  if (c.semantic === 'externalCitation') {
    warnOnce(
      ctx.report,
      'externalCitation',
      'Citation-manager fields (Zotero, Mendeley, EndNote, ...) are kept as read-only pieces with their displayed text between them. Do not edit the text of a paragraph that holds one; change citations in the reference manager instead.',
      2,
    );
  } else if (c.semantic === 'trackedChange') {
    warnOnce(
      ctx.report,
      'trackedChange',
      'Tracked changes are kept as read-only pieces for now; their text is not shown or editable here.',
      3,
    );
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
        return { kind: 'unknownField', label: t === 'begin' ? 'field start' : t === 'separate' ? 'field result' : t === 'end' ? 'field end' : 'field' };
      }
      case 'instrText':
      case 'delInstrText': {
        const citation = CITATION_FIELD.test(el.textContent ?? '');
        return { kind: 'unknownField', label: citation ? 'citation field code' : 'field code', ...(citation ? { semantic: 'externalCitation' as const } : {}) };
      }
      case 'fldSimple': {
        const citation = CITATION_FIELD.test(wAttr(el, 'instr') ?? '');
        return { kind: 'unknownField', label: citation ? 'citation field' : 'field', ...(citation ? { semantic: 'externalCitation' as const } : {}) };
      }
      case 'object':
      case 'control': return { kind: 'oleObject', label: 'embedded object' };
      case 'ins':
      case 'del':
      case 'moveFrom':
      case 'moveTo': return { kind: 'unknownField', label: 'tracked change', semantic: 'trackedChange' };
      case 'commentRangeStart':
      case 'commentRangeEnd':
      case 'commentReference': return { kind: 'unknownField', label: 'comment anchor', semantic: 'comment' };
      case 'drawing': return { kind: 'unknownField', label: 'drawing' };
      case 'pict': return { kind: 'unknownField', label: 'picture' };
      default: break;
    }
  }
  return { kind: 'unknownField', label: el.localName };
}
