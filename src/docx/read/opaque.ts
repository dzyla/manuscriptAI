/**
 * Minimal opaque passthrough: capture an element verbatim, store it as a fragment and return an
 * atom that references it. Task 10 owns the full per-kind classification and the import report; this
 * exists now so that nothing the body readers do not model is ever dropped.
 */
import type { JSONContent } from '@tiptap/core';
import { recordFeature, type FeatureKey } from '../fidelity';
import { captureFragment, captureShell } from '../preserve/xml';
import type { ReadContext } from './context';
import { M_NS, W_NS, firstW } from './ooxml';

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
  return { type: opts.block ? 'opaqueBlock' : 'opaqueInline', attrs: { kind, label, fragmentId } };
}

export interface OpaqueClass {
  kind: FeatureKey;
  label: string;
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
      case 'fldChar':
      case 'instrText':
      case 'delInstrText':
      case 'fldSimple': return { kind: 'unknownField', label: 'field' };
      case 'object':
      case 'control': return { kind: 'oleObject', label: 'embedded object' };
      case 'ins':
      case 'del':
      case 'moveFrom':
      case 'moveTo': return { kind: 'unknownField', label: 'tracked change' };
      case 'commentRangeStart':
      case 'commentRangeEnd':
      case 'commentReference': return { kind: 'unknownField', label: 'comment anchor' };
      case 'drawing': return { kind: 'unknownField', label: 'drawing' };
      case 'pict': return { kind: 'unknownField', label: 'picture' };
      default: break;
    }
  }
  return { kind: 'unknownField', label: el.localName };
}
