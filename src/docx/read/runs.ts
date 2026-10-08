/**
 * w:r / w:hyperlink / w:sdt content of a paragraph -> inline ProseMirror JSON.
 *
 * Nothing is dropped: every child is either mapped to text, a break, a mark or an attribute, kept
 * transparent (a pure markup wrapper whose children are read), deliberately ignored because it
 * carries no content (proofErr, lastRenderedPageBreak), or becomes an opaque atom that holds the
 * element verbatim. Run properties the app does not model (caps, lang, kern, ...) are not carried
 * on the atoms; they live on in the paragraph's original XML while the paragraph is untouched.
 */
import type { JSONContent } from '@tiptap/core';
import { recordFeature } from '../fidelity';
import { stableStringify } from '../preserve/hash';
import { REL_NS, type PackageRel } from '../preserve/types';
import { warnOnce, type ReadContext } from './context';
import { classifyOpaque, readOpaque } from './opaque';
import { mainDocumentPart } from './opc';
import { W_NS, XML_NS, childElements, firstW, int, onOff, wAttr } from './ooxml';
import { halfPointsToPt } from './units';
import { isGoogleSdt, unwrapGoogleSdt } from './sdt';

type MarkJson = NonNullable<JSONContent['marks']>[number];

const HIGHLIGHT_HEX: Record<string, string> = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000',
  darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000',
  darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff',
};

/** Wrappers that are pure markup around runs: their children are read in place. */
const TRANSPARENT = new Set(['smartTag', 'customXml', 'dir', 'bdo']);
/** No content of their own, only layout or editing hints. */
const IGNORED = new Set(['proofErr']);
const IGNORED_RUN_CHILDREN = new Set(['rPr', 'lastRenderedPageBreak']);

const ALLOWED_LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

export function readRuns(container: Element, ctx: ReadContext): JSONContent[] {
  const out: JSONContent[] = [];
  walk(childElements(container), ctx, [], out);
  return mergeAdjacentText(out);
}

/**
 * ProseMirror's JSON loader keeps adjacent text nodes with identical marks apart, while editing and
 * HTML parsing join them. Joining here gives the one canonical form, so a document that is loaded,
 * edited elsewhere and saved back does not look "changed" to the provenance hash.
 */
function mergeAdjacentText(nodes: JSONContent[]): JSONContent[] {
  const out: JSONContent[] = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (prev && prev.type === 'text' && n.type === 'text' && stableStringify(prev.marks ?? []) === stableStringify(n.marks ?? [])) {
      out[out.length - 1] = { ...prev, text: (prev.text ?? '') + (n.text ?? '') };
    } else out.push(n);
  }
  return out;
}

function walk(children: Element[], ctx: ReadContext, marks: MarkJson[], out: JSONContent[]): void {
  for (const el of children) {
    if (el.namespaceURI !== W_NS) {
      out.push(readOpaque(el, ctx, ...kindOf(el)));
      continue;
    }
    const name = el.localName;
    if (name === 'pPr' || IGNORED.has(name)) continue;
    if (name === 'r') readRun(el, ctx, marks, out);
    else if (name === 'hyperlink') readHyperlink(el, ctx, marks, out);
    else if (name === 'sdt') {
      if (isGoogleSdt(el)) walk(unwrapGoogleSdt(el, () => recordFeature(ctx.report, 'googleWrapper')), ctx, marks, out);
      else out.push(readOpaque(el, ctx, ...kindOf(el)));
    } else if (TRANSPARENT.has(name)) {
      warnOnce(
        ctx.report,
        'part',
        `A w:${name} wrapper was unwrapped; its text was kept, but the wrapper itself is only preserved while the paragraph is unedited.`,
        2,
      );
      walk(childElements(el), ctx, marks, out);
    } else out.push(readOpaque(el, ctx, ...kindOf(el)));
  }
}

function kindOf(el: Element): [ReturnType<typeof classifyOpaque>['kind'], string] {
  const c = classifyOpaque(el);
  return [c.kind, c.label];
}

// ─── runs ────────────────────────────────────────────────────────────────────

function readRun(run: Element, ctx: ReadContext, inherited: MarkJson[], out: JSONContent[]): void {
  recordFeature(ctx.report, 'run');
  const rPr = firstW(run, 'rPr');
  const marks = mergeMarks(inherited, rPr ? marksFromRPr(rPr, ctx) : []);
  let text = '';
  const flush = () => {
    if (text) out.push(marks.length ? { type: 'text', text, marks } : { type: 'text', text });
    text = '';
  };
  for (const el of childElements(run)) {
    if (el.namespaceURI !== W_NS) {
      flush();
      out.push(readOpaque(el, ctx, ...kindOf(el), { within: run }));
      continue;
    }
    const name = el.localName;
    if (IGNORED_RUN_CHILDREN.has(name)) continue;
    if (name === 't') text += runText(el);
    else if (name === 'tab') text += '\t';
    else if (name === 'noBreakHyphen') text += '-';
    else if (name === 'softHyphen') text += '­';
    else if (name === 'cr') {
      flush();
      out.push({ type: 'hardBreak' });
    } else if (name === 'br') {
      const type = wAttr(el, 'type');
      if (type === undefined || type === 'textWrapping') {
        flush();
        out.push({ type: 'hardBreak' });
      } else if (type === 'page') {
        flush();
        recordFeature(ctx.report, 'pageBreak');
        out.push({ type: 'pageBreak' });
      } else {
        flush();
        out.push(readOpaque(el, ctx, 'unknownField', 'column break', { within: run }));
      }
    } else {
      flush();
      out.push(readOpaque(el, ctx, ...kindOf(el), { within: run }));
    }
  }
  flush();
}

/** w:t text. Without xml:space="preserve" Word ignores leading and trailing white space. */
function runText(t: Element): string {
  const raw = t.textContent ?? '';
  const space = t.getAttributeNS(XML_NS, 'space') || t.getAttribute('xml:space');
  return space === 'preserve' ? raw : raw.replace(/^\s+|\s+$/g, '');
}

function mergeMarks(base: MarkJson[], own: MarkJson[]): MarkJson[] {
  if (own.length === 0) return base;
  const ownTypes = new Set(own.map(m => m.type));
  return [...base.filter(m => !ownTypes.has(m.type)), ...own];
}

export function marksFromRPr(rPr: Element, ctx: ReadContext): MarkJson[] {
  const marks: MarkJson[] = [];
  const has = (t: string) => marks.some(m => m.type === t);
  for (const el of childElements(rPr)) {
    if (el.namespaceURI !== W_NS) continue;
    switch (el.localName) {
      case 'b': if (onOff(el) && !has('bold')) marks.push({ type: 'bold' }); break;
      case 'i': if (onOff(el) && !has('italic')) marks.push({ type: 'italic' }); break;
      case 'u': {
        const v = wAttr(el, 'val');
        if (v !== 'none' && !has('underline')) marks.push({ type: 'underline' });
        break;
      }
      case 'strike':
      case 'dstrike': if (onOff(el) && !has('strike')) marks.push({ type: 'strike' }); break;
      case 'rFonts': {
        const family = wAttr(el, 'ascii') || wAttr(el, 'hAnsi');
        if (family && !has('fontFamily')) marks.push({ type: 'fontFamily', attrs: { family } });
        break;
      }
      case 'sz': {
        const hp = int(wAttr(el, 'val'));
        if (hp !== undefined && hp > 0 && !has('fontSize')) marks.push({ type: 'fontSize', attrs: { sizePt: halfPointsToPt(hp) } });
        break;
      }
      case 'color': {
        const v = wAttr(el, 'val');
        if (v !== undefined && /^[0-9a-fA-F]{6}$/.test(v) && !has('textColor')) {
          marks.push({ type: 'textColor', attrs: { color: `#${v.toLowerCase()}` } });
        }
        break;
      }
      case 'highlight': {
        const hex = HIGHLIGHT_HEX[wAttr(el, 'val') ?? ''];
        if (hex && !has('highlight')) marks.push({ type: 'highlight', attrs: { color: hex } });
        break;
      }
      case 'shd': {
        const fill = wAttr(el, 'fill');
        if (fill && /^[0-9a-fA-F]{6}$/.test(fill) && !has('highlight')) {
          marks.push({ type: 'highlight', attrs: { color: `#${fill.toLowerCase()}` } });
        }
        break;
      }
      case 'vertAlign': {
        const v = wAttr(el, 'val');
        if (v === 'superscript' && !has('superscript')) marks.push({ type: 'superscript' });
        else if (v === 'subscript' && !has('subscript')) marks.push({ type: 'subscript' });
        break;
      }
      case 'rStyle': {
        const id = ctx.styles.styleIdByWordId.get(wAttr(el, 'val') ?? '');
        if (id && !has('characterStyle')) {
          marks.push({ type: 'characterStyle', attrs: { styleId: id } });
        }
        break;
      }
      default: break;
    }
  }
  return marks;
}

// ─── hyperlinks ──────────────────────────────────────────────────────────────

const relsCache = new WeakMap<ReadContext, Map<string, PackageRel> | null>();

function documentRels(ctx: ReadContext): Map<string, PackageRel> | null {
  if (relsCache.has(ctx)) return relsCache.get(ctx)!;
  let rels: Map<string, PackageRel> | null = null;
  try {
    rels = ctx.pkg.rels(mainDocumentPart(ctx.pkg));
  } catch {
    warnOnce(ctx.report, 'part', 'The document relationships could not be read, so hyperlinks were kept as plain text.', 2);
  }
  relsCache.set(ctx, rels);
  return rels;
}

/** The clickable target of a w:hyperlink, or the reason it is not clickable. Only http, https and mailto are. */
function linkTarget(el: Element, ctx: ReadContext): { href: string } | { why: string } {
  const id = el.getAttributeNS(REL_NS, 'id');
  if (!id) return { why: 'Internal links (bookmark anchors) were kept as plain text.' };
  const rel = documentRels(ctx)?.get(id);
  if (!rel) return { why: 'Hyperlinks with a missing relationship were kept as plain text.' };
  if (rel.targetMode !== 'External') return { why: 'Hyperlinks to package parts were kept as plain text.' };
  const target = rel.target.trim();
  let protocol = '';
  try {
    protocol = new URL(target).protocol.toLowerCase();
  } catch {
    return { why: 'Hyperlinks with an unparsable target were kept as plain text.' };
  }
  if (!ALLOWED_LINK_SCHEMES.has(protocol) || /[\u0000-\u001f\u007f]/.test(target)) {
    return { why: `Hyperlinks to ${protocol || 'unknown'} targets were kept as plain text; only http, https and mailto links are clickable.` };
  }
  return { href: target };
}

function readHyperlink(el: Element, ctx: ReadContext, inherited: MarkJson[], out: JSONContent[]): void {
  const t = linkTarget(el, ctx);
  let marks = inherited;
  if ('href' in t) {
    recordFeature(ctx.report, 'hyperlink');
    marks = mergeMarks(inherited, [{ type: 'link', attrs: { href: t.href } }]);
  } else {
    warnOnce(ctx.report, 'hyperlink', t.why, 2);
  }
  walk(childElements(el), ctx, marks, out);
}
