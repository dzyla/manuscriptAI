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
import { stampProvenance } from '../preserve/hash';
import { captureFragment } from '../preserve/xml';
import { specNormalizeNode } from '../../extensions/schemaSpecs';
import { warnOnce, type ReadContext } from './context';
import { childElements, firstW, int, isW, round4, wAttr } from './ooxml';
import { snapshotCommentIds } from './opaque';
import { readRuns, recordFormatChange } from './runs';
import { isGoogleSdt, unwrapGoogleSdt } from './sdt';
import { twipsToIn } from './units';

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
