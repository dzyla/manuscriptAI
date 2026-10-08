/**
 * Calibration against real documents. fixtures/private/ is gitignored and never committed, so on
 * a fresh checkout this suite is skipped. Failures report only part names and error codes, never
 * document content.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { openPackage } from './package';
import { parseXmlStrict } from '../preserve/xml';
import { readStyles } from './styles';
import { readPageSetup } from './pageSetup';
import { mainDocumentPart } from './opc';
import { createReport, summarizeReport } from '../fidelity';
import type { JSONContent } from '@tiptap/core';
import { emptyPreservationStore } from '../preserve/types';
import { isBlockUntouched } from '../preserve/hash';
import { parseXml } from '../preserve/xml';
import { getSpecSchema } from '../../extensions/schemaSpecs';
import { W_NS, isW } from './ooxml';
import { blockChildren, readParagraph } from './paragraphs';
import { isGoogleSdt } from './sdt';
import type { ReadContext } from './context';

const dir = new URL('../../../fixtures/private/', import.meta.url);
const docs = existsSync(dir) ? readdirSync(dir).filter(f => f.toLowerCase().endsWith('.docx')) : [];

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
});
