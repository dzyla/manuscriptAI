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
import { classifyField, classifyOpaque, readOpaque, recordField } from './opaque';
import { mainDocumentPart } from './opc';
import { W_NS, XML_NS, childElements, firstW, int, onOff, wAttr } from './ooxml';
import { halfPointsToPt } from './units';
import { isGoogleSdt, unwrapGoogleSdt } from './sdt';
import { readDrawing } from './drawings';

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

/**
 * `images`: when given (and the document's images have been prepared, see drawings.ts), a picture in a run is NOT put inline; the
 * image node goes to this list for the paragraph reader to place. A picture that cannot be read as an image stays inline as the
 * opaque atom it always was.
 */
export function readRuns(container: Element, ctx: ReadContext, images?: JSONContent[]): JSONContent[] {
  const out: JSONContent[] = [];
  const outer = fields;
  const outerImages = imageSink;
  fields = [];
  imageSink = images ?? null;
  try {
    walk(childElements(container), ctx, [], out);
    // A field that never reached its separator or end in this paragraph is classified from what was seen.
    for (const f of fields.splice(0)) finishField(f, ctx);
  } finally {
    fields = outer;
    imageSink = outerImages;
  }
  return mergeAdjacentText(out);
}

/** Where the paragraph being read collects its pictures (readRuns is synchronous and not re-entered). */
let imageSink: JSONContent[] | null = null;

// ─── complex fields ──────────────────────────────────────────────────────────

interface OpenField {
  instruction: string;
  codeAtoms: JSONContent[];
  done: boolean;
}
/** Fields begun and not yet ended in the paragraph being read (readRuns is synchronous and not re-entered). */
let fields: OpenField[] = [];

function finishField(f: OpenField, ctx: ReadContext): void {
  if (f.done) return;
  f.done = true;
  const key = classifyField(f.instruction);
  if (key) recordField(key, ctx, f.codeAtoms);
}

/** Track begin / instrText / separate / end so the classification sees the whole, possibly split, instruction. */
function fieldEvent(el: Element, atom: JSONContent, ctx: ReadContext): void {
  if (el.localName === 'fldChar') {
    const t = wAttr(el, 'fldCharType');
    if (t === 'begin') fields.push({ instruction: '', codeAtoms: [], done: false });
    else if (t === 'separate') {
      const f = fields[fields.length - 1];
      if (f) finishField(f, ctx);
    } else if (t === 'end') {
      const f = fields.pop();
      if (f) finishField(f, ctx);
    }
  } else if (el.localName === 'instrText') {
    const f = fields[fields.length - 1];
    if (f && !f.done) {
      f.instruction += el.textContent ?? '';
      f.codeAtoms.push(atom);
    } else if (!f) {
      // The field began in an earlier paragraph: all that is known is this piece.
      const key = classifyField(el.textContent ?? '');
      if (key) recordField(key, ctx, [atom]);
    }
  }
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
    } else if (name === 'fldSimple') {
      const atom = readOpaque(el, ctx, ...kindOf(el));
      const key = classifyField(wAttr(el, 'instr') ?? '');
      if (key) recordField(key, ctx, [atom]);
      out.push(atom);
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
    else if (name === 'softHyphen') text += '\u00ad';
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
      if (name === 'drawing' && imageSink) {
        const image = readDrawing(el, ctx);
        if (image) {
          imageSink.push(image);
          continue;
        }
      }
      const atom = readOpaque(el, ctx, ...kindOf(el), { within: run });
      out.push(atom);
      fieldEvent(el, atom, ctx);
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

/** A formatting-change revision (w:rPrChange / w:pPrChange): shown with its new formatting; the record of the old one is not carried. */
export function recordFormatChange(ctx: ReadContext): void {
  recordFeature(ctx.report, 'formatChange');
  warnOnce(
    ctx.report,
    'formatChange',
    'Formatting-change revisions are shown with their new formatting; the record of the old formatting is kept only while the paragraph is unedited.',
    2,
  );
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
      case 'rPrChange': recordFormatChange(ctx); break;
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
