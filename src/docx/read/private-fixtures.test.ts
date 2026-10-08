/**
 * Calibration against real documents. fixtures/private/ is gitignored and never committed, so on
 * a fresh checkout this suite is skipped. Failures report only part names and error codes, never
 * document content.
 */
import { describe, it, expect, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { openPackage } from './package';
import { parseXmlStrict } from '../preserve/xml';
import { readStyles } from './styles';
import { readPageSetup } from './pageSetup';
import { mainDocumentPart } from './opc';
import { createReport, summarizeReport } from '../fidelity';
import type { JSONContent } from '@tiptap/core';
import { emptyPreservationStore } from '../preserve/types';
import { isBlockUntouched, isTableShellUnchanged, structureHash } from '../preserve/hash';
import { parseXml } from '../preserve/xml';
import { getSpecSchema } from '../../extensions/schemaSpecs';
import { W_NS, isW } from './ooxml';
import { blockChildren, readParagraph, paragraphDrafts } from './paragraphs';
import { applyHeadings, bodyFontSize, detectHeadings, hasHeadings, inferHeadings } from './headings';
import { isGoogleSdt } from './sdt';
import { getNumbering, groupListParagraphs, readNumbering } from './numbering';
import { readTable } from './tables';
import { readBody } from './body';
import { readDocx } from './index';
import { matchCaptions } from './drawings';
import { collectFragmentIds } from '../preserve/refs';
import { planLiftedDrawings } from '../preserve/lifted';
import { collectAssetIds } from '../../db/assetStore';
import { createHash } from 'node:crypto';
import type { ReadContext } from './context';

const dir = new URL('../../../fixtures/private/', import.meta.url);
const docs = existsSync(dir) ? readdirSync(dir).filter(f => f.toLowerCase().endsWith('.docx')) : [];

/**
 * The block stream the body reader builds (`readBody`): images prepared, paragraphs, tables and pictures read, lists grouped per
 * container, in document order. Counts only are ever derived from it in these tests; no document text is printed.
 */
async function readBlocks(name: string) {
  const b = readFileSync(new URL(name, dir));
  const pkg = await openPackage(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  const report = createReport();
  let n = 0;
  const ctx: ReadContext = {
    pkg,
    styles: readStyles(pkg, report),
    report,
    preservation: emptyPreservationStore(),
    assets: [],
    nextId: () => `b${++n}`,
  };
  const body = pkg.xml(mainDocumentPart(pkg))!.getElementsByTagNameNS(W_NS, 'body')[0];
  const sources = blockChildren(body, ctx).filter(el => isW(el, 'p') || isW(el, 'tbl'));
  const { blocks, figures } = await readBody(body, ctx);
  return { pkg, ctx, report, body, sources, blocks, figures, doc: { type: 'doc', content: blocks } as JSONContent };
}

const textOf = (n: JSONContent): string => (n.type === 'text' ? n.text ?? '' : (n.content ?? []).map(textOf).join(''));

const childrenW = (el: Element, local: string): Element[] =>
  Array.from(el.childNodes).filter((c): c is Element => c.nodeType === 1 && isW(c as Element, local));
const all = (blocks: JSONContent[], pred: (n: JSONContent) => boolean): JSONContent[] => {
  const out: JSONContent[] = [];
  const walk = (n: JSONContent): void => {
    if (pred(n)) out.push(n);
    (n.content ?? []).forEach(walk);
  };
  blocks.forEach(walk);
  return out;
};

describe.skipIf(docs.length === 0)('private real-world documents', () => {
  it.each(docs)('%s: opens, every XML part passes strict parsing, nothing is deferred', async name => {
    const b = readFileSync(new URL(name, dir));
    const pkg = await openPackage(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    const xmlParts = pkg.names().filter(n => /\.(xml|rels)$/i.test(n));
    const failures: string[] = [];
    for (const n of xmlParts) {
      try {
        parseXmlStrict(pkg.entry(n)!);
        pkg.xml(n);
      } catch (e) {
        failures.push(`${n}: ${(e as Error).message.slice(0, 60)}`);
      }
    }
    expect(xmlParts.length).toBeGreaterThan(0);
    expect(failures).toEqual([]);
    expect(pkg.deferred().filter(n => /\.(xml|rels)$/i.test(n))).toEqual([]);
    console.log(`${name}: ${xmlParts.length} XML parts parsed strictly, ${failures.length} threw, ${pkg.names().length} entries, ${pkg.deferred().length} deferred (non-XML)`);
  });

  it.each(docs)('%s: styles and page setup read sanely', async name => {
    const b = readFileSync(new URL(name, dir));
    const pkg = await openPackage(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    const report = createReport();
    const { format, styleIdByWordId, headingLevelByStyleId } = readStyles(pkg, report);
    const body = pkg.xml(mainDocumentPart(pkg))!.getElementsByTagName('w:body')[0];
    const { page, extraSections } = readPageSetup(body, report);

    expect(styleIdByWordId.size).toBeGreaterThan(0);
    expect(format.preset).toBe('custom');
    expect(format.defaults.fontFamily.length).toBeGreaterThan(0);
    expect(format.defaults.fontSizePt).toBeGreaterThanOrEqual(6);
    expect(format.defaults.fontSizePt).toBeLessThanOrEqual(24);
    // Every basedOn / next resolves, and no basedOn chain loops.
    for (const s of Object.values(format.styles)) {
      if (s.basedOn) expect(format.styles[s.basedOn], 'basedOn target missing').toBeDefined();
      if (s.next) expect(format.styles[s.next], 'next target missing').toBeDefined();
      const seen = new Set<string>();
      for (let cur: string | undefined = s.id; cur; cur = format.styles[cur].basedOn) {
        expect(seen.has(cur), 'basedOn loop').toBe(false);
        seen.add(cur);
      }
    }
    expect(headingLevelByStyleId.size).toBeGreaterThan(0);
    expect(page.size === 'letter' || page.size === 'a4').toBe(true);
    for (const m of Object.values(page.marginsIn)) {
      expect(m).toBeGreaterThanOrEqual(0.25);
      expect(m).toBeLessThanOrEqual(2);
    }
    const own = Object.values(format.styles).filter(s => [...styleIdByWordId.values()].includes(s.id));
    const kept = own.filter(s => s.preserved).length;
    console.log(
      `${name}: ${styleIdByWordId.size} styles (${own.filter(s => s.type === 'paragraph').length} paragraph, ${own.filter(s => s.type === 'character').length} character), ` +
        `${[...headingLevelByStyleId.values()].filter(l => l === 1).length}/${[...headingLevelByStyleId.values()].filter(l => l === 2).length}/${[...headingLevelByStyleId.values()].filter(l => l === 3).length} heading styles L1/L2/L3, ` +
        `${kept} carry preserved XML, defaults ${format.defaults.fontSizePt}pt, page ${page.size} margins in T${page.marginsIn.top.toFixed(2)} R${page.marginsIn.right.toFixed(2)} B${page.marginsIn.bottom.toFixed(2)} L${page.marginsIn.left.toFixed(2)}, ` +
        `${extraSections} extra sections, ${report.warnings.length} warnings`,
    );
  });

  it.each(docs)('%s: body paragraphs read sanely, nothing dropped, provenance holds', async name => {
    const b = readFileSync(new URL(name, dir));
    const pkg = await openPackage(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    const report = createReport();
    let n = 0;
    const ctx: ReadContext = {
      pkg,
      styles: readStyles(pkg, report),
      report,
      preservation: emptyPreservationStore(),
      assets: [],
      nextId: () => `b${++n}`,
    };
    const body = pkg.xml(mainDocumentPart(pkg))!.getElementsByTagNameNS(W_NS, 'body')[0];
    const children = blockChildren(body, ctx);
    const blockLevelWrappers = report.counts.googleWrapper ?? 0;
    const sources = children.filter(el => isW(el, 'p'));
    const otherBlocks = children.length - sources.length;
    const blocks = sources.flatMap(p => [readParagraph(p, ctx)].flat());
    const doc: JSONContent = { type: 'doc', content: blocks };

    // counts only: no document text is ever printed
    const count = (n: JSONContent, pred: (n: JSONContent) => boolean): number =>
      (pred(n) ? 1 : 0) + (n.content ?? []).reduce((a, c) => a + count(c, pred), 0);
    const headings = count(doc, x => x.type === 'heading');
    const paragraphs = count(doc, x => x.type === 'paragraph');
    const atoms = count(doc, x => x.type === 'opaqueInline');
    const pageBreaks = count(doc, x => x.type === 'pageBreak');
    const links = count(doc, x => !!x.marks?.some(m => m.type === 'link'));

    // 1. one node per source paragraph, every one with provenance that holds
    expect(blocks).toHaveLength(sources.length);
    expect(sources.length).toBeGreaterThan(0);
    expect(headings + paragraphs).toBe(blocks.length);
    // Headings are counted independently from the DOM: a Heading-styled paragraph or a direct outline level 1-3.
    // (Both real documents use direct formatting for their section titles, so 0 is the honest answer.)
    const expectedHeadings = sources.filter(p => {
      const pPr = Array.from(p.childNodes).find(c => c.nodeType === 1 && isW(c as Element, 'pPr')) as Element | undefined;
      const style = pPr?.getElementsByTagNameNS(W_NS, 'pStyle')[0]?.getAttributeNS(W_NS, 'val') ?? '';
      const outline = pPr?.getElementsByTagNameNS(W_NS, 'outlineLvl')[0]?.getAttributeNS(W_NS, 'val');
      return ctx.styles.headingLevelByStyleId.has(ctx.styles.styleIdByWordId.get(style) ?? '') || (outline !== undefined && Number(outline) <= 2);
    }).length;
    expect(headings).toBe(expectedHeadings);
    expect(blocks.filter(x => !isBlockUntouched(x))).toHaveLength(0);
    expect(Object.keys(ctx.preservation.blocks)).toHaveLength(blocks.length);

    // 2. the assembled document is a valid document, and provenance survives schema normalization
    const node = getSpecSchema().nodeFromJSON(doc);
    expect(() => node.check()).not.toThrow();
    const normalized = node.toJSON() as JSONContent;
    expect(normalized.content!.filter(x => !isBlockUntouched(x))).toHaveLength(0);

    // 3. every Google Docs wrapper the reader can reach was unwrapped. Wrappers inside a table (Task 8) or inside
    //    an element kept whole as an opaque atom (a tracked insertion, a drawing) stay in that element's fragment.
    const KEPT_WHOLE = ['tbl', 'ins', 'del', 'moveFrom', 'moveTo', 'drawing', 'pict', 'object'];
    const keptWhole = (el: Element): boolean => {
      for (let p = el.parentNode; p; p = p.parentNode) {
        if (p.nodeType === 1 && (p as Element).namespaceURI === W_NS && KEPT_WHOLE.includes((p as Element).localName)) return true;
      }
      return false;
    };
    const allSdts = Array.from(body.getElementsByTagNameNS(W_NS, 'sdt'));
    const googleExpected = allSdts.filter(e => isGoogleSdt(e) && !keptWhole(e)).length;
    expect(report.counts.googleWrapper ?? 0).toBe(googleExpected);
    const googleInsideFragments = allSdts.filter(e => isGoogleSdt(e) && keptWhole(e)).length;
    expect(report.byCategory[3]).toBe(atoms);

    // 4. no text dropped: every non-blank character of w:t, w:delText and w:instrText is in the document text or in a
    //    preserved fragment. Whitespace is ignored because the reader legitimately trims un-preserved w:t and turns
    //    w:tab / w:br into other whitespace; w:noBreakHyphen ('-') and w:softHyphen (U+00AD) add one visible character
    //    each, so they are added to the source side, counting only those the reader turned into document text.
    const strip = (s: string) => s.replace(/\s+/g, '');
    const docText = (x: JSONContent): string => (x.type === 'text' ? x.text ?? '' : (x.content ?? []).map(docText).join(''));
    const TEXT_ELEMENTS = ['t', 'delText', 'instrText'];
    const textIn = (root: Element): string =>
      TEXT_ELEMENTS.flatMap(n => Array.from(root.getElementsByTagNameNS(W_NS, n))).map(t => t.textContent ?? '').join('');
    const hyphensIn = (root: Element): number =>
      root.getElementsByTagNameNS(W_NS, 'noBreakHyphen').length + root.getElementsByTagNameNS(W_NS, 'softHyphen').length;
    const fragmentRoots = Object.values(ctx.preservation.fragments).map(f => parseXml(f.xml).documentElement);
    const sourceChars = strip(sources.map(textIn).join('')).length;
    const hyphens = sources.reduce((a, p) => a + hyphensIn(p), 0) - fragmentRoots.reduce((a, r) => a + hyphensIn(r), 0);
    const fragmentChars = strip(fragmentRoots.map(textIn).join('')).length;
    const docChars = strip(docText(doc)).length;
    expect(docChars + fragmentChars).toBe(sourceChars + hyphens);

    console.log(
      `body: ${sources.length} paragraphs read (${headings} headings, ${paragraphs} body), ${otherBlocks} non-paragraph body blocks left to later tasks, ` +
        `${report.counts.googleWrapper ?? 0} Google wrappers unwrapped (${blockLevelWrappers} at block level, ${googleInsideFragments} more kept inside preserved fragments), ${atoms} opaque atoms ` +
        `(${Object.values(ctx.preservation.fragments).length} fragments), ${pageBreaks} page breaks, ${links} linked runs, ` +
        `${Object.keys(ctx.preservation.blocks).length} block fragments, ${report.warnings.length} warnings, summary "${summarizeReport(report)}", text chars conserved ${docChars}+${fragmentChars}=${sourceChars + hyphens}`,
    );
  });

  it.each(docs)('%s: inferred headings are plausible (counts here; titles are printed for the reviewer)', async name => {
    // The grouped document INCLUDING its tables: a candidate index is a position in exactly this array.
    const { ctx, report, sources, blocks, doc } = await readBlocks(name);

    // Both real grants style no heading at all, although their styles.xml defines Heading 1-3.
    expect(hasHeadings(doc)).toBe(false);
    expect(ctx.styles.headingLevelByStyleId.size).toBeGreaterThan(0);

    const warningsBefore = report.warnings.length;
    const found = inferHeadings(doc, ctx);
    // Both real documents: 9 inferred headings, with their tables in the block stream.
    expect(found).toHaveLength(9);
    expect(report.counts.inferredHeading).toBe(found.length);
    expect(report.warnings.length).toBe(warningsBefore + 1);

    // The candidate indices are positions in the GROUPED document: pictures (replacing a paragraph, or lifted in front of the
    // paragraph that holds them), lists and tables included. So source block i is NOT block i any more. Checked four independent ways:
    // (a) each index names a paragraph whose ORIGINAL XML (looked up through its provenance, not by position) carries the very text the
    //     candidate carries;
    const collapse = (t: string) => t.replace(/\s+/g, ' ').trim();
    const sourceText = (blk: JSONContent): string => {
      const frag = ctx.preservation.blocks[(blk.attrs!.ooxml as { blockId: string }).blockId];
      return collapse(Array.from(parseXml(frag.xml).documentElement.getElementsByTagNameNS(W_NS, 't')).map(t => t.textContent ?? '').join(''));
    };
    for (const c of found) {
      expect(blocks[c.index].type, `candidate ${c.index}`).toBe('paragraph');
      expect(sourceText(blocks[c.index])).toBe(collapse(c.text));
    }
    // (b) applying them converts exactly those blocks to headings, each with the text it was proposed for, and every table and
    //     picture is the very same untouched object
    const applied = applyHeadings(doc, found);
    expect(applied.content!.filter(x => x.type === 'heading')).toHaveLength(9);
    for (const c of found) {
      expect(applied.content![c.index].type).toBe('heading');
      expect(collapse(textOf(applied.content![c.index]))).toBe(collapse(c.text));
    }
    blocks.forEach((blk, i) => {
      if (blk.type === 'table' || blk.type === 'resizableImage') expect(applied.content![i]).toBe(blk);
    });
    // (c) the pictures and the table really are in the stream the detector saw, and (snsf) titles sit on both sides of the table, so a
    //     missing table or picture would shift them. r01 lifts its 10 floating pictures out in front of their paragraphs, so its
    //     block count is its paragraph count plus 10; snsf's 3 pictures replace their paragraphs, one for one.
    const tableIndexes = blocks.map((x, i) => (x.type === 'table' ? i : -1)).filter(i => i >= 0);
    expect(blocks.filter(x => x.type === 'resizableImage')).toHaveLength(name === 'snsf.docx' ? 3 : 10);
    expect(blocks.length).toBe(sources.length + (name === 'snsf.docx' ? 0 : 10));
    expect(tableIndexes).toEqual(name === 'snsf.docx' ? [88] : []);
    if (name === 'snsf.docx') {
      expect(found.some(c => c.index < 88)).toBe(true);
      expect(found.some(c => c.index > 88)).toBe(true);
    }
    // (d) the pictures change no verdict: these are the nine headings (level and confidence) the reader found when every drawing was
    //     still an opaque atom in its paragraph. They were compared title by title, before and after, when the images were added
    //     (identical lists for both documents); what is pinned here is the tally, which fails if any one of them changes kind.
    const tallyOf = (lvl: number, conf: string) => found.filter(c => c.level === lvl && c.confidence === conf).length;
    expect({
      l1name: tallyOf(1, 'name'), l1format: tallyOf(1, 'format'), l2format: tallyOf(2, 'format'),
      l2sibling: tallyOf(2, 'sibling'), l2name: tallyOf(2, 'name'), l2aim: tallyOf(2, 'aim'),
    }).toEqual(
      name === 'snsf.docx'
        ? { l1name: 1, l1format: 1, l2format: 6, l2sibling: 1, l2name: 0, l2aim: 0 }
        : { l1name: 6, l1format: 0, l2format: 0, l2sibling: 0, l2name: 1, l2aim: 2 },
    );

    // No candidate is a paragraph holding an opaque atom other than a comment anchor, and none is a paragraph
    // the reader gave a Word heading to.
    const blocksByIndex = blocks;
    for (const c of found) {
      const node = blocksByIndex[c.index];
      expect(node.type).toBe('paragraph');
      const atoms = (node.content ?? []).filter(x => x.type !== 'text' && x.type !== 'hardBreak' && x.type !== 'pageBreak' && !(x.type === 'opaqueInline' && x.attrs?.label === 'comment anchor'));
      expect(atoms, `candidate ${c.index}`).toEqual([]);
      expect(c.evidence.length).toBeGreaterThan(0);
    }
    expect(new Set(found.map(c => c.index)).size).toBe(found.length);

    // Which otherwise-qualifying titles were refused only because of an opaque atom? (re-run with atoms removed)
    const drafts = paragraphDrafts(blocks, { format: ctx.styles.format, styleIdByWordId: ctx.styles.styleIdByWordId, blocks: ctx.preservation.blocks });
    const withoutAtoms = detectHeadings(
      drafts.map(d => ({ ...d, atoms: [] })),
      { hasRealHeadings: false, bodyFontSizePt: bodyFontSize(drafts, ctx.styles.format.defaults.fontSizePt) },
    );
    const refused = withoutAtoms.filter(c => !found.some(f => f.index === c.index));
    const atomLabels = new Map<string, number>();
    for (const c of refused) {
      for (const x of blocks[c.index].content ?? []) {
        if (x.type !== 'text') atomLabels.set(String(x.attrs?.label ?? x.type), (atomLabels.get(String(x.attrs?.label ?? x.type)) ?? 0) + 1);
      }
    }

    const tally = (lvl: number, conf: string) => found.filter(c => c.level === lvl && c.confidence === conf).length;
    console.log(
      `headings ${name}: ${found.length} inferred of ${blocks.length} paragraphs; ` +
        `L1 name ${tally(1, 'name')}, L1 format ${tally(1, 'format')}, L2 name ${tally(2, 'name')}, L2 format ${tally(2, 'format')}, L2 aim ${tally(2, 'aim')}, L2 sibling ${tally(2, 'sibling')}, L3 ${found.filter(c => c.level === 3).length}; ` +
        `${refused.length} more refused only for holding an atom ${JSON.stringify(Object.fromEntries(atomLabels))}`,
    );
    console.log(
      `titles ${name}:\n` +
        found.map(c => `  [${String(c.index).padStart(3)}] L${c.level} ${c.confidence.padEnd(7)} ${JSON.stringify(c.text)}\n        evidence: ${c.evidence.join(' | ')}`).join('\n') +
        (refused.length ? '\n  refused (atom): ' + refused.map(c => `[${c.index}] ${JSON.stringify(c.text)} (${c.confidence})`).join('; ') : ''),
    );
  });

  it.each(docs)('%s: images, figures and captions are read; nothing is fetched, dropped or left without provenance (counts only)', async name => {
    const fetchSpy = vi.fn(() => {
      throw new Error('fetch must never be called while reading a .docx');
    });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const { pkg, ctx, report, body, blocks, figures, doc } = await readBlocks(name);
      const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
      const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
      const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
      const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
      const isSnsf = name === 'snsf.docx';

      // ── what the source says, counted from the XML and the package alone ────────────────────────────────────────
      const domDrawings = body.getElementsByTagNameNS(W_NS, 'drawing').length;
      const domAnchored = body.getElementsByTagNameNS(WP, 'anchor').length;
      const domInline = body.getElementsByTagNameNS(WP, 'inline').length;
      const blips = Array.from(body.getElementsByTagNameNS(A, 'blip'));
      const domLinked = blips.filter(b => b.hasAttributeNS(R, 'link')).length;
      const domCropped = Array.from(body.getElementsByTagNameNS(A, 'srcRect')).filter(e => ['l', 't', 'r', 'b'].some(k => Number(e.getAttribute(k)) !== 0)).length;
      const mediaParts = pkg.names().filter(n => n.startsWith('word/media/'));
      // (the package defers every non-XML part, so these are read on demand)
      const mediaData = await Promise.all(mediaParts.map(async n => (await pkg.bytesAsync(n))!));
      expect(mediaParts.every(n => pkg.isDeferred(n))).toBe(true);
      const mediaSha = new Set(mediaData.map(sha));
      const mediaBytes = mediaData.reduce((a, b) => a + b.byteLength, 0);
      expect(domDrawings).toBe(domAnchored + domInline);
      expect(blips).toHaveLength(domDrawings);

      // ── what the reader made ───────────────────────────────────────────────────────────────────────────────────
      const imgs = all(blocks, n => n.type === 'resizableImage');
      const anchoredNodes = imgs.filter(i => i.attrs!.wrap === 'left' || i.attrs!.wrap === 'right' || i.attrs!.wrap === 'block');
      const inlineNodes = imgs.filter(i => i.attrs!.wrap === 'inline');

      // 1. every drawing is an image, none is a placeholder, and the counts are the ones measured by hand against each document
      expect(imgs).toHaveLength(domDrawings);
      expect({ images: imgs.length, anchored: anchoredNodes.length, inline: inlineNodes.length }).toEqual(isSnsf ? { images: 3, anchored: 0, inline: 3 } : { images: 10, anchored: 10, inline: 0 });
      expect(anchoredNodes).toHaveLength(domAnchored);
      expect(inlineNodes).toHaveLength(domInline);
      expect(imgs.filter(i => i.attrs!.assetId === null || i.attrs!.src !== null)).toHaveLength(0); // no placeholder: nothing is linked
      expect(report.counts.inlineImage ?? 0).toBe(domInline);
      expect(report.counts.floatingImageSquare ?? 0).toBe(domAnchored); // every anchored picture of these documents is wrapSquare, positioned left or right
      expect(report.counts.floatingImageOther).toBeUndefined();
      if (!isSnsf) expect(anchoredNodes.map(i => i.attrs!.wrap).sort()).toEqual([...Array(9).fill('left'), 'right']);
      expect(imgs.filter(i => i.attrs!.crop).length).toBe(domCropped);
      expect(domCropped).toBe(isSnsf ? 0 : 3);

      // 2. their bytes: every media part referenced, each once, byte for byte, with the right type and the id A1's store derives
      expect(ctx.assets).toHaveLength(mediaParts.length);
      expect(ctx.assets).toHaveLength(isSnsf ? 3 : 10);
      expect(new Set(ctx.assets.map(a => a.sha256))).toEqual(mediaSha);
      expect(ctx.assets.map(a => a.mime)).toEqual(Array(ctx.assets.length).fill('image/png'));
      expect(ctx.assets.reduce((a, x) => a + x.data.byteLength, 0)).toBe(mediaBytes);
      expect(mediaBytes).toBe(isSnsf ? 1301114 : 2145789);
      for (const a of ctx.assets) {
        expect(sha(new Uint8Array(a.data))).toBe(a.sha256);
        expect(a.id).toBe('a_' + a.sha256.slice(0, 32));
      }
      // reachable: every imported asset is referenced by a node (GC would otherwise remove it), and every reference resolves
      expect([...collectAssetIds(doc)].sort()).toEqual(ctx.assets.map(a => a.id).sort());

      // 3. external references: none exists in these documents, none was read, nothing was fetched
      expect(domLinked).toBe(0);
      expect([...ctx.media!.byRel.values()].filter(m => !m.ok)).toHaveLength(0);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(report.warnings.filter(w => /linked from another location|relationship the document does not contain|file the document does not contain/.test(w.message))).toHaveLength(0);

      // 4. each picture keeps the XML a writer needs: its run, parseable, holding the drawing and the relationship it names
      const referencedFragments = collectFragmentIds(doc);
      for (const i of imgs) {
        const id = i.attrs!.fragmentId as string;
        expect(referencedFragments.has(id)).toBe(true);
        const frag = ctx.preservation.fragments[id];
        const root = parseXml(frag.xml).documentElement;
        expect(root.localName).toBe('r');
        expect(root.getElementsByTagNameNS(W_NS, 'drawing')).toHaveLength(1);
        expect(frag.relIds).toHaveLength(1);
      }

      // 5. provenance: every paragraph keeps its own; a figure paragraph is an image that took its paragraph's; a lifted picture names the paragraph it came from
      const paragraphs = all(blocks, n => n.type === 'paragraph' || n.type === 'heading');
      const standIns = imgs.filter(i => !!i.attrs!.ooxml);
      expect(paragraphs.filter(x => !x.attrs?.ooxml || !isBlockUntouched(x))).toHaveLength(0);
      expect(standIns.filter(x => !isBlockUntouched(x))).toHaveLength(0);
      expect(paragraphs.length + standIns.length).toBe(report.counts.paragraph);
      expect(standIns).toHaveLength(isSnsf ? 3 : 0);
      const paragraphIds = new Set(paragraphs.map(x => (x.attrs!.ooxml as { blockId: string }).blockId));
      const lifted = imgs.filter(i => i.attrs!.anchorBlockId);
      expect(lifted).toHaveLength(isSnsf ? 0 : 10);
      for (const i of lifted) {
        expect(paragraphIds.has(i.attrs!.anchorBlockId as string)).toBe(true);
        // the paragraph it came from still holds the drawing in its original XML, and comes right after the picture (or after its siblings)
        expect(ctx.preservation.blocks[i.attrs!.anchorBlockId as string].xml).toContain('<w:drawing');
      }
      // the record a writer needs to see a delete, a move or a copy of a lifted picture: each is recorded on its host's preserved
      // block with its ordinal among the host's drawings, and that ordinal finds the very drawing in the host's original XML
      expect(Object.values(ctx.preservation.blocks).flatMap(b => b.lifted ?? [])).toHaveLength(lifted.length);
      for (const i of lifted) {
        const host = ctx.preservation.blocks[i.attrs!.anchorBlockId as string];
        const rec = host.lifted!.find(l => l.fragmentId === i.attrs!.fragmentId)!;
        expect(rec).toBeDefined();
        const inHost = Array.from(parseXml(host.xml).documentElement.getElementsByTagNameNS(W_NS, 'drawing'));
        expect(inHost[rec.drawingIndex].getElementsByTagNameNS(A, 'blip')[0].getAttributeNS(R, 'embed')).toBe(ctx.preservation.fragments[i.attrs!.fragmentId as string].relIds[0]);
      }
      expect(planLiftedDrawings(doc, ctx.preservation)).toEqual({ strip: [], emit: [] }); // nothing edited, nothing to do
      for (const i of lifted) {
        const without = { ...doc, content: blocks.filter(b => b !== i) };
        const plan = planLiftedDrawings(without, ctx.preservation);
        expect(plan.emit).toEqual([]);
        expect(plan.strip).toEqual([
          { hostBlockId: i.attrs!.anchorBlockId, drawingIndex: ctx.preservation.blocks[i.attrs!.anchorBlockId as string].lifted!.find(l => l.fragmentId === i.attrs!.fragmentId)!.drawingIndex, fragmentId: i.attrs!.fragmentId, why: 'deleted' },
        ]);
      }
      // an edit to a picture that stays in place (r01's likely first edit: a resize) is seen, for each of them in turn
      for (const i of lifted) {
        const resized = { ...doc, content: blocks.map(b => (b === i ? { ...b, attrs: { ...b.attrs, width: '10%' } } : b)) };
        const plan = planLiftedDrawings(resized, ctx.preservation);
        expect(plan.strip).toEqual([]);
        expect(plan.emit.map(e => [e.why, e.fragmentId])).toEqual([['edited', i.attrs!.fragmentId]]);
        expect(ctx.preservation.blocks[i.attrs!.anchorBlockId as string].lifted!.every(l => typeof l.sourceHash === 'string')).toBe(true);
      }
      // strips come out descending: delete both pictures of the one r01 host that holds two
      const pair = lifted.filter(i => ctx.preservation.blocks[i.attrs!.anchorBlockId as string].lifted!.length === 2);
      expect(pair).toHaveLength(isSnsf ? 0 : 2);
      if (pair.length) {
        const plan = planLiftedDrawings({ ...doc, content: blocks.filter(b => !pair.includes(b)) }, ctx.preservation);
        expect(plan.strip.map(x => x.drawingIndex)).toEqual([1, 0]);
      }
      // r01: one host holds two of the pictures, so its second has ordinal 1
      if (!isSnsf) expect(Object.values(ctx.preservation.blocks).flatMap(b => (b.lifted ?? []).map(l => l.drawingIndex)).sort()).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);

      const ids = [...paragraphIds, ...standIns.map(x => (x.attrs!.ooxml as { blockId: string }).blockId)];
      expect(new Set(ids).size).toBe(ids.length);
      expect(() => getSpecSchema().nodeFromJSON(doc).check()).not.toThrow();

      // 6. captions: found by their label, because neither document uses Word's Caption style (so the styled count is 0, and the label is what matters)
      expect(report.counts.caption).toBeUndefined();
      const matched = figures.filter(f => f.caption !== null);
      expect(figures).toHaveLength(imgs.length);
      expect(matched).toHaveLength(isSnsf ? 2 : 10);
      expect(matched.every(f => f.how === 'label')).toBe(true);
      expect(figures.filter(f => f.caption === null)).toHaveLength(isSnsf ? 1 : 0); // snsf: the schedule diagram before the table has no caption
      expect(matched.every(f => f.caption! > f.image)).toBe(true);
      expect(matched.map(f => f.caption!)).toEqual([...matched.map(f => f.caption!)].sort((x, y) => x - y)); // in document order
      expect(new Set(matched.map(f => f.caption)).size).toBe(matched.length); // each caption used once
      const labelNumbers = matched.map(f => {
        const frag = ctx.preservation.blocks[(blocks[f.caption!].attrs!.ooxml as { blockId: string }).blockId];
        const text = Array.from(parseXml(frag.xml).documentElement.getElementsByTagNameNS(W_NS, 't')).map(t => t.textContent ?? '').join('');
        return Number(/^\s*Fig\.?\s*(\d+)/.exec(text)?.[1]);
      });
      expect([...labelNumbers].sort((x, y) => x - y)).toEqual(isSnsf ? [1, 1] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); // r01: every figure label is claimed, once. snsf: its two sections each number their figures from 1
      // and the independent count: paragraphs that open with "Fig" in the source
      const domCaptionLike = Array.from(body.getElementsByTagNameNS(W_NS, 'p')).filter(p =>
        /^\s*Fig\.?\s*\d+\s*\./.test(Array.from(p.getElementsByTagNameNS(W_NS, 't')).map(t => t.textContent ?? '').join('')),
      ).length;
      expect(domCaptionLike).toBe(matched.length);

      console.log(
        `images ${name}: ${imgs.length} images (${anchoredNodes.length} anchored: ${anchoredNodes.filter(i => i.attrs!.wrap === 'left').length} left, ${anchoredNodes.filter(i => i.attrs!.wrap === 'right').length} right; ${inlineNodes.length} inline), ` +
          `${imgs.filter(i => i.attrs!.crop).length} cropped, ${ctx.assets.length} assets ${JSON.stringify([...new Set(ctx.assets.map(a => a.mime))])} ${mediaBytes} bytes, ${domLinked} external links, ` +
          `${standIns.length} figure paragraphs, ${lifted.length} lifted, ${matched.length} of ${imgs.length} matched to a caption (${matched.filter(f => f.how === 'style').length} by style), fetch calls ${fetchSpy.mock.calls.length}`,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(docs)('%s: numbering is read into lists, nothing dropped, provenance holds (counts only)', async name => {
    const b = readFileSync(new URL(name, dir));
    const pkg = await openPackage(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    const report = createReport();
    let n = 0;
    const ctx: ReadContext = {
      pkg,
      styles: readStyles(pkg, report),
      report,
      preservation: emptyPreservationStore(),
      assets: [],
      nextId: () => `b${++n}`,
    };
    const body = pkg.xml(mainDocumentPart(pkg))!.getElementsByTagNameNS(W_NS, 'body')[0];
    const sources = blockChildren(body, ctx).filter(el => isW(el, 'p'));
    const flat = sources.flatMap(p => [readParagraph(p, ctx)].flat());
    const numbering = readNumbering(pkg, report);
    const blocks = groupListParagraphs(flat.map(node => ({ node })), numbering, ctx);

    const isList = (x: JSONContent) => x.type === 'bulletList' || x.type === 'orderedList';
    const lists: Array<{ node: JSONContent; depth: number }> = [];
    // depth counts list ancestors: a list directly in the document is depth 0, one inside a listItem of a depth-0 list is depth 1
    const walkLists = (x: JSONContent, depth: number): void => {
      if (isList(x)) lists.push({ node: x, depth });
      for (const c of x.content ?? []) walkLists(c, isList(x) ? depth + 1 : depth);
    };
    blocks.forEach(x => walkLists(x, 0));
    const items = lists.reduce((a, l) => a + (l.node.content ?? []).length, 0);
    const kinds = { bullet: lists.filter(l => l.node.type === 'bulletList').length, ordered: lists.filter(l => l.node.type === 'orderedList').length };
    const maxDepth = lists.reduce((a, l) => Math.max(a, l.depth), -1);
    const byDepth = Object.fromEntries([...new Set(lists.map(l => l.depth))].sort().map(d => [d, lists.filter(l => l.depth === d).length]));
    const paragraphsOut: JSONContent[] = [];
    const collect = (x: JSONContent): void => {
      if (x.type === 'paragraph' || x.type === 'heading') paragraphsOut.push(x);
      else (x.content ?? []).forEach(collect);
    };
    blocks.forEach(collect);

    // Independent count from the DOM: paragraphs with their own numPr that names a real numId (0 means "not numbered")
    const directlyNumbered = sources.filter(p => {
      const np = p.getElementsByTagNameNS(W_NS, 'numPr')[0];
      const id = np?.getElementsByTagNameNS(W_NS, 'numId')[0]?.getAttributeNS(W_NS, 'val');
      return !!np && !!id && id !== '0' && Array.from(p.childNodes).some(c => c.nodeType === 1 && isW(c as Element, 'pPr') && Array.from(c.childNodes).some(g => g.nodeType === 1 && isW(g as Element, 'numPr')));
    }).length;
    const numberedHeadings = flat.filter(x => x.type === 'heading' && ctx.preservation.blocks[(x.attrs!.ooxml as { blockId: string }).blockId].xml.includes('<w:numPr')).length;

    // 1. no paragraph lost, duplicated or reordered, and every one still carries provenance that holds
    expect(paragraphsOut.map(x => (x.attrs!.ooxml as { blockId: string }).blockId)).toEqual(flat.map(x => (x.attrs!.ooxml as { blockId: string }).blockId));
    const lostProvenance = paragraphsOut.filter(x => !x.attrs?.ooxml || !isBlockUntouched(x)).length;
    expect(lostProvenance).toBe(0);
    // 2. every directly numbered paragraph is an item, except a numbered heading (stays a heading) and a paragraph whose numId has no
    //    definition (stays a paragraph). Paragraphs numbered only through a style can add items on top, so then it is a lower bound.
    const directIds = sources.flatMap(p => {
      const pPr = Array.from(p.childNodes).find(c => c.nodeType === 1 && isW(c as Element, 'pPr')) as Element | undefined;
      const np = pPr && (Array.from(pPr.childNodes).find(c => c.nodeType === 1 && isW(c as Element, 'numPr')) as Element | undefined);
      const id = np?.getElementsByTagNameNS(W_NS, 'numId')[0]?.getAttributeNS(W_NS, 'val');
      return id && id !== '0' ? [Number(id)] : [];
    });
    const undefinedDirect = directIds.filter(id => !numbering.has(id)).length;
    const expectedItems = directlyNumbered - numberedHeadings - undefinedDirect;
    if (numbering.styleNumPr.size === 0) expect(items).toBe(expectedItems);
    else expect(items).toBeGreaterThanOrEqual(expectedItems);
    expect(report.counts.list ?? 0).toBe(blocks.filter(isList).length);
    // snsf: five one-item bullet lists (measured by hand against the document); r01 has no w:num at all
    if (name === 'snsf.docx') {
      expect(lists).toHaveLength(5);
      expect(maxDepth).toBe(0);
      expect(kinds).toEqual({ bullet: 5, ordered: 0 });
    }
    if (name === 'r01.docx') expect(lists).toHaveLength(0);
    // 3. the grouped document is valid
    expect(() => getSpecSchema().nodeFromJSON({ type: 'doc', content: blocks }).check()).not.toThrow();
    console.log(
      `numbering ${name}: part ${numbering.part ?? 'none'}, ${numbering.size} numIds defined, ${numbering.styleNumPr.size} styles carry numbering, ` +
        `${directlyNumbered} paragraphs with their own numPr (${numberedHeadings} of them headings); ` +
        `${lists.length} lists (${kinds.bullet} bullet, ${kinds.ordered} ordered), ${blocks.filter(isList).length} top-level, by depth ${JSON.stringify(byDepth)} (max depth ${maxDepth}), ${items} list items, ` +
        `${paragraphsOut.length - flat.length === 0 ? 'all' : 'NOT all'} ${flat.length} paragraphs kept, ${lostProvenance} lost provenance, ` +
        `complexNumbering ${report.counts.complexNumbering ?? 0} (${report.warnings.filter(w => w.feature === 'complexNumbering').length} distinct warnings), summary "${summarizeReport(report)}"`,
    );
  });
  /**
   * Task 10: the whole `readDocx` result for each real document, asserted. Every number below was measured (by hand, or from the
   * XML and the package alone, not through the reader) before it was written here, and the report is compared whole, so a count that
   * moves, a warning that appears or one that goes missing fails this test. Counts and the reader's own fixed messages only: no
   * document text is read out or printed.
   */
  it.each(docs)('%s: the assembled import result and its full report are exactly what was measured', async name => {
    const fetchSpy = vi.fn(() => {
      throw new Error('fetch must never be called while reading a .docx');
    });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const isSnsf = name === 'snsf.docx';
      const bytes = readFileSync(new URL(name, dir));
      const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const r = await readDocx(input, undefined, name);
      const doc = r.doc;
      const blocks = doc.content!;
      const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

      // ── the source, counted from its XML and package alone ───────────────────────────────────────────────────
      const pkg = await openPackage(input);
      const main = mainDocumentPart(pkg);
      const body = pkg.xml(main)!.getElementsByTagNameNS(W_NS, 'body')[0];
      const rawCount = (...names: string[]) => names.reduce((n, x) => n + body.getElementsByTagNameNS(W_NS, x).length, 0);
      const commentsPart = pkg.xml('word/comments.xml');
      const commentsInPart = commentsPart ? commentsPart.getElementsByTagNameNS(W_NS, 'comment').length : 0;
      const usedRelIds = new Set<string>();
      const scan = (el: Element): void => {
        for (let i = 0; i < el.attributes.length; i++) if (el.attributes[i].namespaceURI === REL) usedRelIds.add(el.attributes[i].value);
        for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) scan(c as Element);
      };
      scan(body);
      const definedRels = pkg.rels(main);

      // ── the result as a whole ────────────────────────────────────────────────────────────────────────────────
      expect(r.fileName).toBe(name);
      expect(r.original).toBe(input);
      expect(() => getSpecSchema().nodeFromJSON(doc).check()).not.toThrow();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(r.format.page.size).toBe('letter');
      // the margins are the body section's own pgMar (twentieths of a point, read here straight from the XML), not a default
      const pgMar = body.getElementsByTagNameNS(W_NS, 'sectPr')[0].getElementsByTagNameNS(W_NS, 'pgMar')[0];
      const margin = (side: string) => Number(pgMar.getAttributeNS(W_NS, side)) / 1440;
      expect(r.format.page.marginsIn).toEqual({ top: margin('top'), right: margin('right'), bottom: margin('bottom'), left: margin('left') });
      expect(r.format.page.marginsIn).toEqual(isSnsf ? { top: 709 / 1440, right: 0.75, bottom: 1, left: 0.75 } : { top: 0.5, right: 0.5, bottom: 0.5, left: 0.5 });

      // ── the report, whole ────────────────────────────────────────────────────────────────────────────────────
      const INFERRED =
        'This document uses no Word heading styles. 9 section headings were inferred from bold or larger text, short lines, aim titles, numbering and common section names. Review them: each can be accepted or rejected, and none is applied until you accept it.';
      const CITATION_FIELDS =
        'Reference-manager fields (Zotero, Mendeley, EndNote, Paperpile, ...) are kept as read-only pieces. Where a field is split, the text it displays is ordinary editable text between those pieces, so editing a paragraph that holds one can break the field. Change citations and bibliographies in the reference manager instead.';
      const expected = isSnsf
        ? {
            counts: {
              paragraphStyle: 12, keepRules: 52, characterStyle: 13, tabStops: 102, tableBorders: 2, paragraph: 177, run: 2233, pageBreak: 8,
              unknownField: 94, externalCitation: 22, inlineImage: 3, list: 5, table: 1, mergedCell: 6, externalBibliography: 1,
              inferredHeading: 9, pageSetup: 1,
            },
            byCategory: { 1: 2459, 2: 188, 3: 94, 4: 0 },
            pageCount: 20,
            described: { trackedChange: 0, commentAnchor: 0, citationField: 94 },
            figures: { images: 3, captioned: 2 },
            warnings: [
              { feature: 'externalCitation', category: 2, message: CITATION_FIELDS },
              { feature: 'tableBorders', category: 2, message: 'Table borders and shading are shown approximately. The original table formatting is kept for export.' },
              { feature: 'inferredHeading', category: 2, message: INFERRED },
              { feature: 'part', category: 3, message: '3 header or footer parts have content (text, a page number or a picture). They are kept in the file but not shown or editable here.' },
            ],
          }
        : {
            counts: {
              paragraphStyle: 20, keepRules: 251, characterStyle: 23, tableBorders: 1, paragraph: 135, googleWrapper: 78, unknownField: 184,
              comment: 52, run: 1046, trackedChange: 32, floatingImageSquare: 10, formatChange: 13, inferredHeading: 9, pageSetup: 1,
            },
            byCategory: { 1: 1410, 2: 261, 3: 184, 4: 0 },
            described: { trackedChange: 32, commentAnchor: 152, citationField: 0 },
            figures: { images: 10, captioned: 10 },
            warnings: [
              { feature: 'part', category: 2, message: 'A duplicate style definition was ignored; the first one is used.' },
              { feature: 'comment', category: 3, message: 'Comments are kept as read-only anchors for now; their text and replies are not shown or editable here. They stay in the file.' },
              { feature: 'trackedChange', category: 3, message: 'Tracked changes are kept as read-only pieces for now; their text is not shown or editable here.' },
              { feature: 'formatChange', category: 2, message: 'Formatting-change revisions are shown with their new formatting; the record of the old formatting is kept only while the paragraph is unedited.' },
              { feature: 'part', category: 2, message: 'A cropped picture is shown whole (its crop is kept for export).' },
              { feature: 'inferredHeading', category: 2, message: INFERRED },
              { feature: 'formatChange', category: 3, message: '10 formatting changes sit on a paragraph mark, in a table, or inside other preserved content (such as a tracked insertion). They are counted above and kept in the file, but are not shown as separate pieces.' },
              { feature: 'part', category: 3, message: '1 header or footer part has content (text, a page number or a picture). It is kept in the file but not shown or editable here.' },
            ],
          };
      expect(r.report).toEqual(expected);
      expect(summarizeReport(r.report)).toBe(
        isSnsf
          ? 'Imported 20 pages · 5 lists · 22 citations · 1 bibliography · 4 warnings'
          : 'Imported 45 tracked changes · 52 comments · 8 warnings',
      );

      // ── review state: the numbers are the document's, from sources the reader did not produce ───────────────────
      // tracked changes: the w:ins / w:del / w:moveFrom / w:moveTo elements; formatting changes: the w:rPrChange elements
      const revisions = rawCount('ins', 'del', 'moveFrom', 'moveTo');
      expect(revisions).toBe(isSnsf ? 0 : 32);
      expect(r.report.counts.trackedChange ?? 0).toBe(revisions);
      expect(rawCount('rPrChange', 'pPrChange')).toBe(isSnsf ? 0 : 13);
      expect(r.report.counts.formatChange ?? 0).toBe(rawCount('rPrChange', 'pPrChange'));
      // comments: the comment records in comments.xml, which the reader never opens
      expect(commentsInPart).toBe(isSnsf ? 0 : 52);
      expect(r.report.counts.comment ?? 0).toBe(commentsInPart);
      // the atoms that stand for them: one each for the revisions, three at most per comment (start, end, reference)
      const atoms = all(blocks, n => n.type === 'opaqueInline' || n.type === 'opaqueBlock');
      expect(atoms.filter(a => a.attrs!.label === 'tracked change')).toHaveLength(revisions);
      expect(atoms.filter(a => a.attrs!.label === 'comment anchor')).toHaveLength(isSnsf ? 0 : 152);
      // 157 anchors in the XML: 152 are atoms of their own, and the other 5 sit inside a tracked change's atom (counted with it, kept in its XML)
      expect(rawCount('commentRangeStart', 'commentRangeEnd', 'commentReference')).toBe(isSnsf ? 0 : 157);
      const insideRevisions = atoms
        .filter(a => a.attrs!.label === 'tracked change')
        .reduce((n, a) => {
          const root = parseXml(r.preservation.fragments[a.attrs!.fragmentId as string].xml).documentElement;
          return n + ['commentRangeStart', 'commentRangeEnd', 'commentReference'].reduce((m, x) => m + root.getElementsByTagNameNS(W_NS, x).length, 0);
        }, 0);
      expect(insideRevisions).toBe(isSnsf ? 0 : 5);
      // snsf's 94 atoms are the pieces of its 23 reference-manager fields: 69 w:fldChar (begin, separate, end) and 25 w:instrText
      // (two of the 23 codes continue in a second piece). None is left over as "other preserved".
      expect(rawCount('fldChar') + rawCount('instrText')).toBe(isSnsf ? 94 : 0);
      expect((r.report.counts.externalCitation ?? 0) + (r.report.counts.externalBibliography ?? 0)).toBe(isSnsf ? 23 : 0);
      // every atom is a category-3 record and the report's category-3 total is exactly the atoms (no section break in either document)
      expect(r.report.byCategory[3]).toBe(atoms.length);
      expect(r.report.counts.sectionBreak).toBeUndefined();
      expect(rawCount('sectPr')).toBe(1);
      expect(Object.keys(r.preservation.fragments)).toHaveLength(atoms.length + (isSnsf ? 3 : 10)); // and the pictures' runs

      // ── structure ────────────────────────────────────────────────────────────────────────────────────────────
      expect(r.headingCandidates).toHaveLength(9); // proposed ...
      expect(all(blocks, n => n.type === 'heading')).toHaveLength(0); // ... and not applied
      expect(r.report.counts.inferredHeading).toBe(9);
      expect(all(blocks, n => n.type === 'table')).toHaveLength(isSnsf ? 1 : 0);
      expect(r.report.counts.table ?? 0).toBe(isSnsf ? 1 : 0);
      const bullets = all(blocks, n => n.type === 'bulletList');
      expect(bullets).toHaveLength(isSnsf ? 5 : 0);
      expect(bullets.every(b => b.content!.length === 1)).toBe(true);
      expect(r.report.counts.list ?? 0).toBe(bullets.length);
      if (isSnsf) {
        const table = all(blocks, n => n.type === 'table')[0];
        expect(table.content).toHaveLength(17);
        expect(all([table], n => n.type === 'tableCell' || n.type === 'tableHeader')).toHaveLength(21);
        expect(rawCount('tc') - 21).toBe(11); // the 32 source cells, 11 of them continuations folded into a rowspan
        // the budget table as imported has an unchanged shell; "Add row below" (the editor's table menu) changes the structure, and a
        // cell edit does not
        expect(isTableShellUnchanged(table)).toBe(true);
        const grown = structuredClone(table);
        grown.content!.push(structuredClone(grown.content![grown.content!.length - 1]));
        expect(isTableShellUnchanged(grown)).toBe(false);
        const edited = structuredClone(table);
        edited.content![0].content![0].content = [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }];
        expect(isTableShellUnchanged(edited)).toBe(true);
        expect(isBlockUntouched(edited)).toBe(false);
      }

      // ── images: read, not left opaque ────────────────────────────────────────────────────────────────────────
      const domDrawings = rawCount('drawing');
      const imgs = all(blocks, n => n.type === 'resizableImage');
      expect(domDrawings).toBe(isSnsf ? 3 : 10);
      expect(imgs).toHaveLength(domDrawings);
      expect(atoms.filter(a => a.attrs!.label === 'drawing' || a.attrs!.label === 'picture')).toHaveLength(0);
      expect(r.assets).toHaveLength(isSnsf ? 3 : 10);
      expect(r.assets.map(a => a.mime)).toEqual(Array(r.assets.length).fill('image/png'));
      expect([...collectAssetIds(doc)].sort()).toEqual(r.assets.map(a => a.id).sort());
      const figures = matchCaptions(blocks);
      expect(figures.filter(f => f.caption !== null)).toHaveLength(isSnsf ? 2 : 10);
      // and the SHIPPED import carries those pairings: the caption feature is not just a function the tests call. r01 pairs 10 of its 10
      // pictures (every "Fig. N." label), snsf 2 of its 3 (its schedule diagram has no caption).
      expect(r.figures).toEqual(figures);
      expect(r.figures.filter(f => f.caption !== null)).toHaveLength(isSnsf ? 2 : 10);
      expect(r.figures).toHaveLength(isSnsf ? 3 : 10);
      expect(r.report.figures).toEqual(isSnsf ? { images: 3, captioned: 2 } : { images: 10, captioned: 10 });
      expect(r.report.counts.caption).toBeUndefined(); // that count is for Word's Caption style, which neither document uses
      expect(imgs.filter(i => i.attrs!.anchorBlockId)).toHaveLength(isSnsf ? 0 : 10); // r01: all ten lifted
      expect(Object.values(r.preservation.blocks).flatMap(b => b.lifted ?? [])).toHaveLength(isSnsf ? 0 : 10);
      expect(planLiftedDrawings(doc, r.preservation)).toEqual({ strip: [], emit: [] });

      // ── preservation: every stored piece is referenced, every reference is stored, and the relationships are the document's ──
      expect([...collectFragmentIds(doc)].sort()).toEqual(Object.keys(r.preservation.fragments).sort());
      const expectedIds = [...usedRelIds].filter(id => definedRels.has(id)).sort();
      expect([...usedRelIds].filter(id => !definedRels.has(id))).toEqual([]); // neither document has a dangling id
      expect(Object.keys(r.preservation.rels).sort()).toEqual(expectedIds);
      expect(expectedIds).toHaveLength(isSnsf ? 6 : 11); // the pictures, and the header and footer references of the body's own section
      for (const id of expectedIds) {
        const rel = definedRels.get(id)!;
        expect(r.preservation.rels[id]).toEqual({ id: rel.id, type: rel.type, target: rel.target, ...(rel.targetMode ? { targetMode: rel.targetMode } : {}) });
      }
      expect(Object.values(r.preservation.rels).filter(x => x.targetMode === 'External')).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();

      // ── reading twice gives the same result ────────────────────────────────────────────────────────────────────
      const again = await readDocx(input, undefined, name);
      expect({ ...again, original: null }).toEqual({ ...r, original: null });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(docs)('%s: tables are read, no cell, row or paragraph dropped or duplicated, provenance holds (counts only)', async name => {
    const { ctx, report, body, blocks, doc } = await readBlocks(name);
    const tcCount = (t: Element): number => childrenW(t, 'tr').reduce((a, r) => a + childrenW(r, 'tc').length, 0);

    // ── what the source says, counted from the XML alone ────────────────────────────────────────────────────────
    const domTables = Array.from(body.getElementsByTagNameNS(W_NS, 'tbl'));
    const domTop = domTables.filter(t => !domTables.some(o => o !== t && o.contains(t)));
    const domNested = domTables.length - domTop.length;
    const domRows = domTables.reduce((a, t) => a + childrenW(t, 'tr').length, 0);
    const domCells = domTables.reduce((a, t) => a + tcCount(t), 0);
    const tcs = domTables.flatMap(t => childrenW(t, 'tr').flatMap(r => childrenW(r, 'tc')));
    const tcProp = (tc: Element, local: string): Element | undefined => {
      const pr = childrenW(tc, 'tcPr')[0];
      return pr && childrenW(pr, local)[0];
    };
    const domColspan = tcs.filter(tc => Number(tcProp(tc, 'gridSpan')?.getAttributeNS(W_NS, 'val') ?? 1) > 1).length;
    const domRestart = tcs.filter(tc => tcProp(tc, 'vMerge')?.getAttributeNS(W_NS, 'val') === 'restart').length;
    const domContinue = tcs.filter(tc => tcProp(tc, 'vMerge') && tcProp(tc, 'vMerge')!.getAttributeNS(W_NS, 'val') !== 'restart').length;
    const continuationParagraphs = tcs
      .filter(tc => tcProp(tc, 'vMerge') && tcProp(tc, 'vMerge')!.getAttributeNS(W_NS, 'val') !== 'restart')
      .reduce((a, tc) => a + childrenW(tc, 'p').length, 0);
    const KEPT_WHOLE = ['ins', 'del', 'moveFrom', 'moveTo', 'drawing', 'pict', 'object'];
    const keptWhole = (el: Element): boolean => {
      for (let q = el.parentNode; q; q = q.parentNode) if (q.nodeType === 1 && (q as Element).namespaceURI === W_NS && KEPT_WHOLE.includes((q as Element).localName)) return true;
      return false;
    };
    const domParagraphs = Array.from(body.getElementsByTagNameNS(W_NS, 'p')).filter(x => !keptWhole(x)).length;

    // ── what the reader made ────────────────────────────────────────────────────────────────────────────────────
    const tableNodes = all(blocks, n => n.type === 'table');
    const topTables = blocks.filter(b => b.type === 'table');
    const cellNodes = all(blocks, n => n.type === 'tableCell' || n.type === 'tableHeader');
    const rowNodes = all(blocks, n => n.type === 'tableRow');
    const folded = cellNodes.reduce((a, c) => a + ((c.attrs!.rowspan as number) - 1), 0);
    const paragraphNodes = all(blocks, n => n.type === 'paragraph' || n.type === 'heading');
    const colspanNodes = cellNodes.filter(c => (c.attrs!.colspan as number) > 1).length;
    const rowspanNodes = cellNodes.filter(c => (c.attrs!.rowspan as number) > 1).length;
    const gridCols = (t: JSONContent) => domTop[topTables.indexOf(t)].getElementsByTagNameNS(W_NS, 'gridCol').length;

    // 1. every table, row and cell of the source is accounted for: a model cell, or a cell folded into a rowspan
    expect(topTables).toHaveLength(domTop.length);
    expect(tableNodes).toHaveLength(domTables.length);
    expect(domNested).toBe(tableNodes.length - topTables.length);
    expect(rowNodes).toHaveLength(domRows);
    expect(cellNodes.length + folded).toBe(domCells);
    // 2. merges: horizontal ones exactly; vertical ones fold exactly the continuation cells (these documents' continuations are all blank)
    expect(colspanNodes).toBe(domColspan);
    expect(rowspanNodes).toBe(domRestart);
    expect(folded).toBe(domContinue);
    expect(report.counts.mergedCell ?? 0).toBe(cellNodes.filter(c => (c.attrs!.colspan as number) > 1 || (c.attrs!.rowspan as number) > 1).length);
    expect(report.counts.table ?? 0).toBe(tableNodes.length);
    // 3. no paragraph lost, duplicated or without provenance; the only source paragraphs not in the model are the hidden ones of folded cells
    //    A figure on a line of its own is an image node that stands for its paragraph (it owns the paragraph's provenance), so those are
    //    counted with the paragraphs: every source paragraph is a paragraph node or such an image, and nothing else.
    const standInImages = all(blocks, n => n.type === 'resizableImage' && !!n.attrs?.ooxml);
    expect(paragraphNodes.length + standInImages.length).toBe(domParagraphs - continuationParagraphs);
    expect(standInImages).toHaveLength(name === 'snsf.docx' ? 3 : 0);
    const ids = paragraphNodes.map(x => (x.attrs!.ooxml as { blockId: string }).blockId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(paragraphNodes.filter(x => !x.attrs?.ooxml || !isBlockUntouched(x))).toHaveLength(0);
    expect(tableNodes.filter(t => !t.attrs?.ooxml || !isBlockUntouched(t))).toHaveLength(0);
    for (const t of tableNodes) {
      const frag = ctx.preservation.blocks[(t.attrs!.ooxml as { blockId: string }).blockId];
      expect(frag, 'table fragment').toBeDefined();
      expect(parseXml(frag.xml).documentElement.localName).toBe('tbl');
    }
    // 3b. a text-only edit in a cell leaves the table's structure hash alone (the writer can patch the original <w:tbl>) and changes its content hash
    for (const t of tableNodes) {
      const stored = (t.attrs!.ooxml as { structureHash: string }).structureHash;
      expect(structureHash(t)).toBe(stored);
      const edited = JSON.parse(JSON.stringify(t)) as JSONContent;
      const target = all([edited], n => n.type === 'text')[0];
      if (target) {
        target.text = (target.text ?? '') + '!';
        expect(structureHash(edited)).toBe(stored);
        expect(isBlockUntouched(edited)).toBe(false);
      }
    }
    // 4. the model with its tables is a valid document and provenance survives schema normalization
    const normalized = getSpecSchema().nodeFromJSON(doc);
    expect(() => normalized.check()).not.toThrow();
    const back = normalized.toJSON() as JSONContent;
    expect(all(back.content!, n => n.type === 'table' || n.type === 'paragraph').filter(n => !isBlockUntouched(n))).toHaveLength(0);
    // 5. no text lost anywhere in the body (paragraphs and tables): model text plus preserved fragments equals the source's w:t / w:delText / w:instrText
    const strip = (x: string) => x.replace(/\s+/g, '');
    const TEXT = ['t', 'delText', 'instrText'];
    const textIn = (root: Element): string => TEXT.flatMap(t => Array.from(root.getElementsByTagNameNS(W_NS, t))).map(t => t.textContent ?? '').join('');
    const hyphensIn = (root: Element): number => root.getElementsByTagNameNS(W_NS, 'noBreakHyphen').length + root.getElementsByTagNameNS(W_NS, 'softHyphen').length;
    const fragRoots = Object.values(ctx.preservation.fragments).map(f => parseXml(f.xml).documentElement);
    const docChars = strip(textOf(doc)).length;
    const fragChars = strip(fragRoots.map(textIn).join('')).length;
    const hyphens = hyphensIn(body) - fragRoots.reduce((a, r) => a + hyphensIn(r), 0);
    expect(docChars + fragChars).toBe(strip(textIn(body)).length + hyphens);

    // Neither real document has a table property the model cannot hold, so nothing is recorded as tableLayout. tableBorders also counts
    // the table STYLE that carries borders (styles.xml, read by readStyles): r01 has one such style and no table, snsf has the style
    // plus its table's own tblBorders.
    expect(report.counts.tableLayout).toBeUndefined();
    expect(report.counts.tableBorders ?? 0).toBe(name === 'snsf.docx' ? 2 : 1);

    // ── hand-measured shape of the two real documents ───────────────────────────────────────────────────────────
    if (name === 'r01.docx') {
      expect({ tables: tableNodes.length, rows: rowNodes.length, cells: cellNodes.length }).toEqual({ tables: 0, rows: 0, cells: 0 });
    }
    if (name === 'snsf.docx') {
      // one table: 17 rows on a 2-column grid, 32 source cells of which 11 are blank vMerge continuations folded into 4 restart cells
      // (spanning 5, 5, 3 and 2 rows); two rows (0 and 11) are a single cell spanning both columns; no nested table.
      expect(tableNodes).toHaveLength(1);
      expect(domNested).toBe(0);
      expect(rowNodes).toHaveLength(17);
      expect(gridCols(topTables[0])).toBe(2);
      // cells per row in the model: a row below a restart has one fewer (its continuation cell is folded into the rowspan above)
      expect(rowNodes.map(r => (r.content ?? []).length)).toEqual([1, 2, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 2, 1, 1, 2, 1]);
      expect(cellNodes).toHaveLength(21);
      expect(colspanNodes).toBe(2);
      expect(rowspanNodes).toBe(4);
      expect(cellNodes.filter(c => (c.attrs!.rowspan as number) > 1).map(c => c.attrs!.rowspan)).toEqual([5, 5, 3, 2]);
      expect(folded).toBe(11);
      expect(report.counts.mergedCell).toBe(6);
      expect(all([topTables[0]], n => n.type === 'paragraph')).toHaveLength(21);
      expect(blocks.findIndex(b => b.type === 'table')).toBe(88);
      expect(blocks).toHaveLength(157);
    }
    console.log(
      `tables ${name}: ${tableNodes.length} tables (${topTables.length} top-level, ${domNested} nested), ${rowNodes.length} rows, ${cellNodes.length} cells in the model + ${folded} folded = ${domCells} source cells, ` +
        `grid columns ${JSON.stringify(topTables.map(gridCols))}, ${colspanNodes} colspan cells, ${rowspanNodes} rowspan cells (rowspans ${JSON.stringify(cellNodes.filter(c => (c.attrs!.rowspan as number) > 1).map(c => c.attrs!.rowspan))}), ` +
        `${paragraphNodes.length} paragraphs kept of ${domParagraphs} (${continuationParagraphs} hidden in folded cells), 0 lost provenance, text chars conserved ${docChars}+${fragChars}, ` +
        `tableBorders ${report.counts.tableBorders ?? 0}, tableLayout ${report.counts.tableLayout ?? 0}, mergedCell ${report.counts.mergedCell ?? 0}`,
    );
  });
});
