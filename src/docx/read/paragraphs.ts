/**
 * w:p -> a paragraph or heading node with Word's direct formatting, original-OOXML provenance and
 * the paragraph's source XML kept in `preservation.blocks`.
 *
 * Provenance holds for EVERY paragraph: the node is schema-normalized before it is stamped, so
 * `isBlockUntouched` is true immediately after import and the exporter can re-emit the original
 * `<w:p>` for any paragraph the author does not edit.
 */
import type { JSONContent } from '@tiptap/core';
import { recordFeature } from '../fidelity';
import { isBlockUntouched, stampProvenance } from '../preserve/hash';
import type { PreservationStore } from '../preserve/types';
import { captureFragment, parseXml } from '../preserve/xml';
import { specNormalizeNode } from '../../extensions/schemaSpecs';
import { warnOnce, type ReadContext } from './context';
import { childElements, firstW, int, isW, onOff, round4, wAttr } from './ooxml';
import { snapshotCommentIds } from './opaque';
import { readRuns, recordFormatChange } from './runs';
import { isGoogleSdt, unwrapGoogleSdt } from './sdt';
import { twipsToIn } from './units';
import { resolveStyle } from '../../services/formatPresets';
import type { DocFormat } from '../../types';

export { isGoogleSdt, unwrapGoogleSdt } from './sdt';

type Align = 'left' | 'center' | 'right' | 'justify';

const JC: Record<string, Align> = {
  left: 'left', start: 'left', center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify',
};

/**
 * The block-level children of a container (w:body, w:tc, ...), with Google Docs wrappers unwrapped
 * at any depth and recorded as googleWrapper. Block readers (body, table cells) iterate this, not
 * the raw children, so a wrapped paragraph is never mistaken for an opaque content control.
 */
export function blockChildren(parent: Element, ctx: ReadContext): Element[] {
  const out: Element[] = [];
  for (const el of childElements(parent)) {
    if (isGoogleSdt(el)) out.push(...unwrapGoogleSdt(el, () => recordFeature(ctx.report, 'googleWrapper')));
    else out.push(el);
  }
  return out;
}

interface ParagraphProps {
  attrs: Record<string, unknown>;
  headingLevel: 1 | 2 | 3 | null;
}

function readProps(p: Element, ctx: ReadContext): ParagraphProps {
  const attrs: Record<string, unknown> = {};
  let headingLevel: 1 | 2 | 3 | null = null;
  const pPr = firstW(p, 'pPr');
  let styleId: string | null = null;
  if (pPr) {
    const pStyle = firstW(pPr, 'pStyle');
    const wordId = pStyle && wAttr(pStyle, 'val');
    if (wordId) {
      styleId = ctx.styles.styleIdByWordId.get(wordId) ?? null;
    }
    for (const el of childElements(pPr)) {
      if (isW(el, 'jc')) {
        const a = JC[wAttr(el, 'val') ?? ''];
        if (a) attrs.textAlign = a;
      } else if (isW(el, 'spacing')) {
        const before = int(wAttr(el, 'before'));
        const after = int(wAttr(el, 'after'));
        const line = int(wAttr(el, 'line'));
        if (before !== undefined && before >= 0) attrs.spaceBefore = round4(before / 20);
        if (after !== undefined && after >= 0) attrs.spaceAfter = round4(after / 20);
        if (line !== undefined && line > 0) {
          const rule = wAttr(el, 'lineRule');
          attrs.lineSpacing =
            rule === 'exact' || rule === 'atLeast'
              ? { rule, value: round4(line / 20) }
              : { rule: 'auto', value: round4(line / 240) };
        }
      } else if (isW(el, 'ind')) {
        const left = int(wAttr(el, 'left') ?? wAttr(el, 'start'));
        const first = int(wAttr(el, 'firstLine'));
        const hanging = int(wAttr(el, 'hanging'));
        if (left !== undefined) attrs.indentLeft = round4(twipsToIn(left));
        if (hanging !== undefined && hanging > 0) attrs.indentFirstLine = round4(-twipsToIn(hanging));
        else if (first !== undefined) attrs.indentFirstLine = round4(twipsToIn(first));
      } else if (isW(el, 'outlineLvl')) {
        const lvl = int(wAttr(el, 'val'));
        if (lvl !== undefined && lvl >= 0 && lvl <= 2) headingLevel = (lvl + 1) as 1 | 2 | 3;
      } else if (isW(el, 'keepNext') || isW(el, 'keepLines') || isW(el, 'widowControl') || isW(el, 'pageBreakBefore')) {
        recordFeature(ctx.report, 'keepRules');
      } else if (isW(el, 'tabs')) {
        recordFeature(ctx.report, 'tabStops');
      } else if (isW(el, 'pPrChange')) {
        recordFormatChange(ctx);
      }
    }
  }
  attrs.styleId = styleId;
  const byStyle = styleId ? ctx.styles.headingLevelByStyleId.get(styleId) : undefined;
  return { attrs, headingLevel: byStyle ?? headingLevel };
}

/**
 * Read one w:p. Always returns a single node (the union return type is the documented contract):
 * a page break is an inline atom, so a paragraph holding a break and text is NOT split and keeps
 * its provenance. See specs/pageBreak.ts.
 */
export function readParagraph(p: Element, ctx: ReadContext): JSONContent | JSONContent[] {
  recordFeature(ctx.report, 'paragraph');
  const { attrs, headingLevel } = readProps(p, ctx);
  const fragmentsBefore = new Set(Object.keys(ctx.preservation.fragments));
  const featuresBefore = { counts: { ...ctx.report.counts }, byCategory: { ...ctx.report.byCategory } };
  const restoreCommentIds = snapshotCommentIds(ctx.report);
  const content = readRuns(p, ctx);
  if (headingLevel) recordFeature(ctx.report, 'heading');
  if (attrs.styleId === 'caption') recordFeature(ctx.report, 'caption');

  const node: JSONContent = headingLevel
    ? { type: 'heading', attrs: { ...attrs, level: headingLevel }, ...(content.length ? { content } : {}) }
    : { type: 'paragraph', attrs, ...(content.length ? { content } : {}) };

  let normalized: JSONContent;
  try {
    normalized = specNormalizeNode(node);
  } catch {
    // Cannot happen for nodes this reader builds. If it ever does, keep the text, but stamp NOTHING:
    // a degraded node must never read as "untouched", or its degraded content would become the export
    // basis after the first edit. Without provenance the exporter regenerates it.
    // The atoms are dropped from this paragraph, so their fragments and report counts are withdrawn too:
    // nothing may reference (or be counted for) content that is no longer in the document.
    for (const id of Object.keys(ctx.preservation.fragments)) if (!fragmentsBefore.has(id)) delete ctx.preservation.fragments[id];
    ctx.report.counts = featuresBefore.counts;
    ctx.report.byCategory = featuresBefore.byCategory;
    restoreCommentIds();
    warnOnce(
      ctx.report,
      'part',
      'A paragraph could not be represented exactly; only its plain text was kept. Tracked changes, comments and other preserved content in it were not carried over, and its original formatting will not be reused.',
      2,
    );
    const text = content.map(c => c.text ?? '').join('');
    return specNormalizeNode({ type: 'paragraph', attrs: { styleId: null }, ...(text ? { content: [{ type: 'text', text }] } : {}) });
  }
  const blockId = ctx.nextId();
  ctx.preservation.blocks[blockId] = captureFragment(p);
  return stampProvenance(normalized, blockId);
}

/**
 * What the heading detector (headings.ts) needs to know about one body paragraph, read off the node the
 * reader produced. Computed from the node alone, so it is cheap, pure and testable without a package.
 */
export interface ParagraphDraft {
  /** Position of the paragraph in the document's top-level content (what `applyHeadings` is given). */
  index: number;
  node: JSONContent;
  /** Visible text, trimmed. Atoms contribute nothing. */
  text: string;
  words: number;
  /**
   * Every non-blank text run is bold: directly, through its character style, or through the paragraph's style.
   * (Word documents often get bold from a "Strong" character style, so direct marks alone would miss them.)
   */
  allBold: boolean;
  /** The smallest font size (pt) among the non-blank runs, when known: an explicit size, else the paragraph style's. */
  minFontSizePt: number | null;
  /** Labels of opaque atoms in the paragraph, other than comment anchors (zero-width markers). */
  atoms: string[];
  /** A line break, or a page break that follows text: the paragraph is more than one line. */
  multiline: boolean;
}

const COMMENT_ANCHOR = 'comment anchor';

/** Where a draft can look beyond the node: the document's styles and the paragraph's original XML. */
export interface DraftSource {
  format?: DocFormat;
  styleIdByWordId?: Map<string, string>;
  /** `preservation.blocks`: the original `<w:p>` of every paragraph, by block id. */
  blocks?: PreservationStore['blocks'];
}

/** Subtrees whose text is not the paragraph's own visible text (revisions, drawings, embedded objects). */
const FOREIGN = ['ins', 'del', 'moveFrom', 'moveTo', 'drawing', 'pict', 'object', 'pPr'];

/**
 * Bold and size as Word shows them, read from the paragraph's ORIGINAL XML. The node cannot say this: the model has
 * no way to write "this run is explicitly NOT bold", and a document whose every body run is `Strong` + `<w:b w:val="0"/>`
 * would read as all bold. Returns null when the paragraph has no visible text.
 */
function sourceSignals(p: Element, src: Required<Pick<DraftSource, 'format' | 'styleIdByWordId'>>): { allBold: boolean; minFontSizePt: number | null } | null {
  const { format, styleIdByWordId } = src;
  const pStyleEl = firstW(firstW(p, 'pPr') ?? p, 'pStyle');
  const paraId = pStyleEl ? styleIdByWordId.get(wAttr(pStyleEl, 'val') ?? '') ?? null : null;
  const para = resolveStyle(format, paraId);
  let seen = false;
  let allBold = true;
  let minSize: number | null = null;
  const visit = (el: Element): void => {
    for (const c of childElements(el)) {
      if (FOREIGN.some(n => isW(c, n))) continue;
      if (!isW(c, 'r')) {
        visit(c);
        continue;
      }
      const text = childElements(c).filter(x => isW(x, 't')).map(x => x.textContent ?? '').join('');
      if (!text.trim()) continue;
      seen = true;
      const rPr = firstW(c, 'rPr');
      const b = rPr && firstW(rPr, 'b');
      const rStyle = rPr && firstW(rPr, 'rStyle');
      const charId = rStyle ? styleIdByWordId.get(wAttr(rStyle, 'val') ?? '') : undefined;
      const bold = b ? onOff(b) : charId && format.styles[charId] ? resolveStyle(format, charId).bold || para.bold : para.bold;
      if (!bold) allBold = false;
      const sz = rPr && firstW(rPr, 'sz');
      const half = sz ? int(wAttr(sz, 'val')) : undefined;
      const size = half !== undefined && half > 0 ? half / 2 : para.fontSizePt;
      minSize = minSize === null ? size : Math.min(minSize, size);
    }
  };
  visit(p);
  return seen ? { allBold, minFontSizePt: minSize } : null;
}

function draftOf(node: JSONContent, index: number, source: DraftSource = {}): ParagraphDraft {
  const { format } = source;
  const paraStyle = typeof node.attrs?.styleId === 'string' ? node.attrs.styleId : null;
  const paraResolved = format ? resolveStyle(format, paraStyle) : null;
  let text = '';
  let seenText = false;
  let allBold = true;
  let minSize: number | null = null;
  let everySized = true;
  const atoms: string[] = [];
  let multiline = false;
  for (const c of node.content ?? []) {
    if (c.type === 'text') {
      text += c.text ?? '';
      if (!(c.text ?? '').trim()) continue;
      seenText = true;
      const marks = c.marks ?? [];
      const charStyle = marks.find(m => m.type === 'characterStyle')?.attrs?.styleId;
      const bold =
        marks.some(m => m.type === 'bold') ||
        !!paraResolved?.bold ||
        (!!format && typeof charStyle === 'string' && !!format.styles[charStyle] && resolveStyle(format, charStyle).bold);
      if (!bold) allBold = false;
      const marked = marks.find(m => m.type === 'fontSize')?.attrs?.sizePt;
      const size = typeof marked === 'number' ? marked : paraResolved?.fontSizePt;
      if (typeof size === 'number') minSize = minSize === null ? size : Math.min(minSize, size);
      else everySized = false;
    } else if (c.type === 'hardBreak') {
      multiline = true;
    } else if (c.type === 'pageBreak') {
      // a break in front of the text is just where the section starts; one after text splits the paragraph
      if (seenText) multiline = true;
    } else if (c.type === 'opaqueInline' && c.attrs?.label === COMMENT_ANCHOR) {
      // zero-width marker: the visible text is unaffected
    } else {
      atoms.push(String(c.attrs?.label ?? c.type));
    }
  }
  text = text.trim();
  const draft: ParagraphDraft = {
    index,
    node,
    text,
    words: text ? text.split(/\s+/).length : 0,
    allBold: seenText && allBold,
    minFontSizePt: seenText && everySized ? minSize : null,
    atoms,
    multiline,
  };
  // An untouched paragraph still has its original XML, which knows what the node cannot: an explicit "not bold".
  const blockId = (node.attrs?.ooxml as { blockId?: string } | null | undefined)?.blockId;
  const fragment = blockId ? source.blocks?.[blockId] : undefined;
  if (fragment && source.format && source.styleIdByWordId && isBlockUntouched(node)) {
    try {
      const sig = sourceSignals(parseXml(fragment.xml).documentElement, { format: source.format, styleIdByWordId: source.styleIdByWordId });
      if (sig) {
        draft.allBold = sig.allBold;
        draft.minFontSizePt = sig.minFontSizePt;
      }
    } catch {
      // keep the node-derived answer
    }
  }
  return draft;
}

/**
 * The `ParagraphDraft` of every plain paragraph in `blocks` (headings, tables and other blocks are skipped; indices stay
 * document positions). Pass the document's styles (and, for an imported document, `preservation.blocks`) so bold and size that
 * come from a style or from an explicit override are seen, not only direct marks.
 */
export function paragraphDrafts(blocks: JSONContent[], source: DraftSource = {}): ParagraphDraft[] {
  const out: ParagraphDraft[] = [];
  blocks.forEach((b, i) => {
    if (b.type === 'paragraph') out.push(draftOf(b, i, source));
  });
  return out;
}
