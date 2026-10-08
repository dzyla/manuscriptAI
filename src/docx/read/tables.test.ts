import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import type { JSONContent } from '@tiptap/core';
import { XMLSerializer } from '@xmldom/xmldom';
import { openPackage } from './package';
import { readStyles } from './styles';
import { mainDocumentPart } from './opc';
import { readParagraph, blockChildren } from './paragraphs';
import { readTable } from './tables';
import { getNumbering, groupListParagraphs } from './numbering';
import { inferHeadings } from './headings';
import { readOpaque, classifyOpaque } from './opaque';
import type { ReadContext } from './context';
import { createReport, FIDELITY } from '../fidelity';
import { emptyPreservationStore } from '../preserve/types';
import { blockHash, isBlockUntouched, structureHash } from '../preserve/hash';
import { parseXml } from '../preserve/xml';
import { getSpecSchema } from '../../extensions/schemaSpecs';
import { W_NS, isW } from './ooxml';

const load = (name: string): ArrayBuffer => {
  const b = readFileSync(new URL(`../../test/fixtures/docx/${name}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

/**
 * What the body reader (Task 9) will do with the block stream: paragraphs, tables, anything else opaque, then the list grouping.
 * Numbering comes from `getNumbering(ctx)`, as the body reader will get it.
 */
async function readDocument(data: ArrayBuffer, preservation = emptyPreservationStore()) {
  const pkg = await openPackage(data);
  const report = createReport();
  let n = 0;
  const ctx: ReadContext = {
    pkg,
    styles: readStyles(pkg, report),
    report,
    preservation,
    assets: [],
    nextId: () => `b${++n}`,
  };
  const body = pkg.xml(mainDocumentPart(pkg))!.getElementsByTagNameNS(W_NS, 'body')[0];
  const sources = blockChildren(body, ctx).filter(el => !isW(el, 'sectPr'));
  const flat = sources.flatMap((el): JSONContent[] => {
    if (isW(el, 'p')) return [readParagraph(el, ctx)].flat();
    if (isW(el, 'tbl')) return [readTable(el, ctx)];
    const c = classifyOpaque(el);
    return [readOpaque(el, ctx, c.kind, c.label, { block: true })];
  });
  const blocks = groupListParagraphs(flat.map(node => ({ node })), getNumbering(ctx), ctx);
  return { pkg, ctx, report, body, sources, blocks, doc: { type: 'doc', content: blocks } as JSONContent };
}

const textOf = (n: JSONContent): string => (n.type === 'text' ? n.text ?? '' : (n.content ?? []).map(textOf).join(''));
const walk = (n: JSONContent, fn: (x: JSONContent) => void): void => {
  fn(n);
  (n.content ?? []).forEach(c => walk(c, fn));
};
const all = (blocks: JSONContent[], pred: (n: JSONContent) => boolean): JSONContent[] => {
  const out: JSONContent[] = [];
  blocks.forEach(b => walk(b, n => pred(n) && out.push(n)));
  return out;
};
const blockIdOf = (n: JSONContent): string => (n.attrs!.ooxml as { blockId: string }).blockId;
const rowsOf = (t: JSONContent): JSONContent[] => t.content ?? [];
const cellsOf = (row: JSONContent): JSONContent[] => row.content ?? [];
const cellTexts = (row: JSONContent): string[] => cellsOf(row).map(textOf);

/**
 * An independent occupancy model of a table: which cell covers each grid position of each row, written from the merge
 * rules alone (a rowspan keeps covering the next rows' positions, so a row below a merged cell simply has fewer cells).
 * Returns, per row, the text found at each grid column ('' for a column no cell reaches).
 */
function gridOf(table: JSONContent, columns: number): string[][] {
  const covered = new Map<string, string>();
  const out: string[][] = [];
  rowsOf(table).forEach((row, r) => {
    let col = 0;
    for (const cell of cellsOf(row)) {
      while (covered.has(`${r}:${col}`)) col++;
      const { colspan, rowspan } = cell.attrs as { colspan: number; rowspan: number };
      for (let dr = 0; dr < rowspan; dr++) for (let dc = 0; dc < colspan; dc++) covered.set(`${r + dr}:${col + dc}`, textOf(cell));
      col += colspan;
    }
    out.push(Array.from({ length: columns }, (_, c) => covered.get(`${r}:${c}`) ?? ''));
  });
  return out;
}

// ─── inline packages ────────────────────────────────────────────────────────────────────────────────────────

const WNS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${WNS}">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2."/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
<w:num w:numId="3"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${WNS}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;

async function inline(bodyXml: string, numberingXml = NUMBERING): Promise<ArrayBuffer> {
  const zip = new JSZip();
  const ct = 'application/vnd.openxmlformats-officedocument.wordprocessingml';
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${ct}.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="${ct}.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="${ct}.numbering+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RNS}/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RNS}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${RNS}/numbering" Target="numbering.xml"/></Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="${WNS}"><w:body>${bodyXml}</w:body></w:document>`);
  zip.file('word/styles.xml', STYLES);
  zip.file('word/numbering.xml', numberingXml);
  return zip.generateAsync({ type: 'arraybuffer' });
}
const readInline = async (bodyXml: string) => readDocument(await inline(bodyXml));

const p = (text: string, pPr = '', rPr = '') =>
  `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t>${text}</w:t></w:r></w:p>`;
const li = (text: string, numId: number, ilvl = 0) => p(text, `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`);
const tc = (inner: string, tcPr = '') => `<w:tc>${tcPr ? `<w:tcPr>${tcPr}</w:tcPr>` : ''}${inner}</w:tc>`;
const tr = (cells: string, trPr = '') => `<w:tr>${trPr ? `<w:trPr>${trPr}</w:trPr>` : ''}${cells}</w:tr>`;
const grid = (...widths: number[]) => `<w:tblGrid>${widths.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;
const tbl = (gridXml: string, rows: string, tblPr = '') => `<w:tbl><w:tblPr>${tblPr}</w:tblPr>${gridXml}${rows}</w:tbl>`;
const restart = '<w:vMerge w:val="restart"/>';
const cont = '<w:vMerge/>';
const span = (n: number) => `<w:gridSpan w:val="${n}"/>`;
const goog = (n: number, inner: string) => `<w:sdt><w:sdtPr><w:tag w:val="goog_rdk_${n}"/></w:sdtPr><w:sdtContent>${inner}</w:sdtContent></w:sdt>`;

/** Every non-blank character of w:t / w:delText / w:instrText under `root`. */
const strip = (s: string) => s.replace(/\s+/g, '');
const sourceChars = (root: Element): string =>
  strip(['t', 'delText', 'instrText'].flatMap(n => Array.from(root.getElementsByTagNameNS(W_NS, n))).map(t => t.textContent ?? '').join(''));

/** The text in the model plus the text of the opaque fragments in it equals the text of the source: nothing was lost. */
function expectTextConserved(r: Awaited<ReturnType<typeof readDocument>>, tableEls: Element[]) {
  // top-level paragraphs are outside the tables under test
  const scope = r.blocks.filter(b => b.type !== 'paragraph');
  const inModel = strip(scope.map(textOf).join(''));
  const fragmentIds = all(scope, n => n.type === 'opaqueInline' || n.type === 'opaqueBlock').map(n => n.attrs!.fragmentId as string);
  const inFragments = strip(fragmentIds.map(id => sourceChars(parseXml(r.ctx.preservation.fragments[id].xml).documentElement)).join(''));
  const source = tableEls.map(sourceChars).join('');
  expect(inModel.length + inFragments.length).toBe(source.length);
}

// ─── tables.docx ────────────────────────────────────────────────────────────────────────────────────────────

describe('tables.docx: one table with a known grid', async () => {
  const r = await readDocument(load('tables.docx'));
  const table = r.blocks.find(b => b.type === 'table')!;

  it('reads a paragraph, a table and a paragraph, in order', () => {
    expect(r.blocks.map(b => b.type)).toEqual(['paragraph', 'table', 'paragraph']);
    expect(textOf(r.blocks[0])).toBe('Before the table.');
    expect(textOf(r.blocks[2])).toBe('After the table.');
  });

  it('has the four rows of the source', () => {
    expect(rowsOf(table)).toHaveLength(4);
    expect(rowsOf(table).map(row => cellsOf(row).length)).toEqual([4, 3, 3, 4]);
  });

  it('carries the four distinct grid widths (twips / 15 = CSS px) as colwidth', () => {
    const header = cellsOf(rowsOf(table)[0]);
    expect(header.map(c => c.attrs!.colwidth)).toEqual([[120], [180], [240], [96]]);
    // rows below the header carry the same widths for the columns their cells sit in
    expect(cellsOf(rowsOf(table)[3]).map(c => c.attrs!.colwidth)).toEqual([[120], [180], [240], [96]]);
  });

  it('makes the tblHeader row tableHeader cells and every other cell a tableCell', () => {
    expect(cellsOf(rowsOf(table)[0]).map(c => c.type)).toEqual(['tableHeader', 'tableHeader', 'tableHeader', 'tableHeader']);
    for (const row of rowsOf(table).slice(1)) for (const c of cellsOf(row)) expect(c.type).toBe('tableCell');
  });

  it('reads gridSpan as colspan, with the widths of both columns it covers', () => {
    const wide = cellsOf(rowsOf(table)[1])[1];
    expect(textOf(wide)).toBe('Wide cell');
    expect(wide.attrs).toMatchObject({ colspan: 2, rowspan: 1, colwidth: [180, 240] });
  });

  it('reads the vMerge restart as rowspan 2 and gives the continuation row one fewer cell', () => {
    const tall = cellsOf(rowsOf(table)[1])[0];
    expect(textOf(tall)).toBe('Tall cell');
    expect(tall.attrs).toMatchObject({ colspan: 1, rowspan: 2, colwidth: [120] });
    expect(cellsOf(rowsOf(table)[2])).toHaveLength(3);
  });

  it('puts every cell of the row below the vMerge restart in its source column (compared to the fixture grid)', () => {
    // The fixture's grid, written out by hand: row 2 is  [continuation of "Tall cell"] [r2 c2 ...] [r2 c3] [r2 c4]
    const row2 = rowsOf(table)[2];
    expect(cellTexts(row2)[0]).toBe('r2 c2 first paragraphr2 c2 second paragraph');
    expect(cellTexts(row2)[1]).toBe('r2 c3');
    expect(cellTexts(row2)[2]).toBe('r2 c4');
    // and widths agree with the columns those cells sit in (index 1..3 of the grid), not with columns 0..2
    expect(cellsOf(row2).map(c => c.attrs!.colwidth)).toEqual([[180], [240], [96]]);
    // the occupancy model places the same texts in the same grid columns
    const g = gridOf(table, 4);
    expect(g[0]).toEqual(['Head A', 'Head B', 'Head C', 'Head D']);
    expect(g[1]).toEqual(['Tall cell', 'Wide cell', 'Wide cell', 'r1 c4']);
    expect(g[2]).toEqual(['Tall cell', 'r2 c2 first paragraphr2 c2 second paragraph', 'r2 c3', 'r2 c4']);
    expect(g[3][0]).toBe('r3 c1');
    expect(g[3][3]).toBe('r3 c4');
  });

  it('keeps both paragraphs of the two-paragraph cell', () => {
    const cell = cellsOf(rowsOf(table)[2])[0];
    expect(cell.content!.map(x => x.type)).toEqual(['paragraph', 'paragraph']);
    expect(cell.content!.map(textOf)).toEqual(['r2 c2 first paragraph', 'r2 c2 second paragraph']);
  });

  it('reads the nested table as a table inside the cell, with its own rows and cells', () => {
    const cell = cellsOf(rowsOf(table)[3])[1];
    const nested = cell.content!.find(x => x.type === 'table')!;
    expect(nested).toBeDefined();
    expect(rowsOf(nested).map(cellTexts)).toEqual([['nested 1', 'nested 2'], ['nested 3', 'nested 4']]);
    expect(cellsOf(rowsOf(nested)[0]).map(c => c.attrs!.colwidth)).toEqual([[60], [60]]);
    // the cell's own trailing paragraph is kept too
    expect(cell.content!.map(x => x.type)).toEqual(['table', 'paragraph']);
  });

  it('keeps an empty cell as a cell with one empty paragraph', () => {
    const empty = cellsOf(rowsOf(table)[3])[2];
    expect(empty.content).toHaveLength(1);
    expect(empty.content![0].type).toBe('paragraph');
    expect(textOf(empty)).toBe('');
  });

  it('records tblBorders as a category-2 approximation and keeps the table XML behind the table node', () => {
    expect(FIDELITY.tableBorders).toBe(2);
    expect(r.report.counts.tableBorders).toBe(1);
    expect(r.report.warnings.filter(w => w.feature === 'tableBorders').map(w => w.category)).toEqual([2]);
    const frag = r.ctx.preservation.blocks[blockIdOf(table)];
    expect(frag).toBeDefined();
    const root = parseXml(frag.xml).documentElement;
    expect(root.localName).toBe('tbl');
    expect(root.getElementsByTagNameNS(W_NS, 'tblBorders')).toHaveLength(1);
    expect(root.getElementsByTagNameNS(W_NS, 'tr')).toHaveLength(6); // its 4 rows and the nested table's 2: the whole subtree is kept
  });

  it('counts the table, the nested table and the merged cells', () => {
    expect(r.report.counts.table).toBe(2);
    expect(r.report.counts.mergedCell).toBe(2); // the gridSpan cell and the vMerge cell
    expect(r.report.counts.tableLayout).toBeUndefined();
  });

  it('stamps the table, the nested table and every paragraph in them with provenance that holds', () => {
    const tables = all(r.blocks, n => n.type === 'table');
    expect(tables).toHaveLength(2);
    for (const t of tables) {
      expect(t.attrs!.ooxml).toBeTruthy();
      expect(isBlockUntouched(t)).toBe(true);
    }
    const paragraphs = all([table], n => n.type === 'paragraph');
    const fromSource = Array.from(r.body.getElementsByTagNameNS(W_NS, 'tbl')[0].getElementsByTagNameNS(W_NS, 'p'));
    // every source paragraph is a model paragraph except the one blank paragraph of the vMerge continuation cell (Word hides it)
    expect(paragraphs).toHaveLength(fromSource.length - 1);
    for (const para of paragraphs) {
      expect(para.attrs!.ooxml, textOf(para)).toBeTruthy();
      expect(isBlockUntouched(para), textOf(para)).toBe(true);
      expect(parseXml(r.ctx.preservation.blocks[blockIdOf(para)].xml).documentElement.localName).toBe('p');
    }
    expect(new Set(paragraphs.map(blockIdOf)).size).toBe(paragraphs.length);
  });

  it('is a valid document and its provenance survives schema normalization', () => {
    const node = getSpecSchema().nodeFromJSON(r.doc);
    expect(() => node.check()).not.toThrow();
    const back = node.toJSON() as JSONContent;
    expect(isBlockUntouched(back.content![1])).toBe(true);
    for (const para of all(back.content!, n => n.type === 'paragraph')) expect(isBlockUntouched(para)).toBe(true);
  });

  it('conserves every character of text', () => {
    expectTextConserved(r, Array.from(r.body.getElementsByTagNameNS(W_NS, 'tbl')).slice(0, 1));
  });
});

// ─── adversarial shapes ─────────────────────────────────────────────────────────────────────────────────────

describe('tables: merges, ragged rows and the shapes that must not shift or drop a cell', () => {
  it('a vMerge three rows tall has rowspan 3 and the rows below keep their cells in the right columns', async () => {
    const r = await readInline(
      tbl(grid(1000, 2000, 3000),
        tr(tc(p('A'), restart) + tc(p('b1')) + tc(p('c1'))) +
        tr(tc('<w:p/>', cont) + tc(p('b2')) + tc(p('c2'))) +
        tr(tc('<w:p/>', cont) + tc(p('b3')) + tc(p('c3'))) +
        tr(tc(p('A4')) + tc(p('b4')) + tc(p('c4')))),
    );
    const t = r.blocks[0];
    expect(cellsOf(rowsOf(t)[0])[0].attrs).toMatchObject({ rowspan: 3 });
    expect(rowsOf(t).map(cellTexts)).toEqual([['A', 'b1', 'c1'], ['b2', 'c2'], ['b3', 'c3'], ['A4', 'b4', 'c4']]);
    expect(gridOf(t, 3)).toEqual([['A', 'b1', 'c1'], ['A', 'b2', 'c2'], ['A', 'b3', 'c3'], ['A4', 'b4', 'c4']]);
    expect(cellsOf(rowsOf(t)[1]).map(c => c.attrs!.colwidth)).toEqual([[133], [200]]);
    expect(r.report.counts.mergedCell).toBe(1);
  });

  it('a cell that is both gridSpan 2 and vMerge is one cell with colspan 2 and rowspan 2', async () => {
    const r = await readInline(
      tbl(grid(1500, 1500, 3000),
        tr(tc(p('big'), span(2) + restart) + tc(p('c1'))) +
        tr(tc('<w:p/>', span(2) + cont) + tc(p('c2')))),
    );
    const t = r.blocks[0];
    expect(cellsOf(rowsOf(t)[0])[0].attrs).toMatchObject({ colspan: 2, rowspan: 2, colwidth: [100, 100] });
    expect(rowsOf(t).map(cellTexts)).toEqual([['big', 'c1'], ['c2']]);
    expect(gridOf(t, 3)).toEqual([['big', 'big', 'c1'], ['big', 'big', 'c2']]);
    expect(r.report.counts.mergedCell).toBe(1);
  });

  it('a vMerge continuation that holds text is kept as its own cell: the text is not lost', async () => {
    const r = await readInline(
      tbl(grid(1000, 2000), tr(tc(p('top'), restart) + tc(p('x1'))) + tr(tc(p('hidden words'), cont) + tc(p('x2')))),
    );
    const t = r.blocks[0];
    expect(rowsOf(t).map(cellTexts)).toEqual([['top', 'x1'], ['hidden words', 'x2']]);
    expect(cellsOf(rowsOf(t)[0])[0].attrs).toMatchObject({ rowspan: 1 });
    expect(r.report.counts.tableLayout).toBe(1);
    expect(r.report.warnings.some(w => w.feature === 'tableLayout' && w.category === 2)).toBe(true);
    expectTextConserved(r, Array.from(r.body.getElementsByTagNameNS(W_NS, 'tbl')));
  });

  it('a vMerge continuation with nothing above it (first row) is an ordinary cell, not dropped', async () => {
    const r = await readInline(tbl(grid(1000, 2000), tr(tc(p('lonely'), cont) + tc(p('x1'))) + tr(tc(p('y0')) + tc(p('y1')))));
    const t = r.blocks[0];
    expect(rowsOf(t).map(cellTexts)).toEqual([['lonely', 'x1'], ['y0', 'y1']]);
    expect(r.report.counts.tableLayout).toBe(1);
  });

  it('an empty orphan continuation still stays a cell (the row must keep its column)', async () => {
    const r = await readInline(tbl(grid(1000, 2000), tr(tc('<w:p/>', cont) + tc(p('x1'))) + tr(tc(p('y0')) + tc(p('y1')))));
    const t = r.blocks[0];
    expect(cellsOf(rowsOf(t)[0])).toHaveLength(2);
    expect(gridOf(t, 2)[0]).toEqual(['', 'x1']);
  });

  it('a continuation whose span differs from the cell above is not merged into it', async () => {
    const r = await readInline(
      tbl(grid(1000, 1000, 1000),
        tr(tc(p('wide'), span(2) + restart) + tc(p('c1'))) +
        tr(tc('<w:p/>', cont) + tc(p('b2')) + tc(p('c2')))),
    );
    const t = r.blocks[0];
    expect(cellsOf(rowsOf(t)[0])[0].attrs).toMatchObject({ colspan: 2, rowspan: 1 });
    expect(rowsOf(t)[1].content).toHaveLength(3);
    expect(gridOf(t, 3)).toEqual([['wide', 'wide', 'c1'], ['', 'b2', 'c2']]);
    expect(r.report.counts.tableLayout).toBe(1);
  });

  it('a merge that ends is closed: a later continuation does not attach to the old restart', async () => {
    const r = await readInline(
      tbl(grid(1000, 2000),
        tr(tc(p('A'), restart) + tc(p('x1'))) +
        tr(tc('<w:p/>', cont) + tc(p('x2'))) +
        tr(tc(p('B')) + tc(p('x3'))) +
        tr(tc('<w:p/>', cont) + tc(p('x4')))),
    );
    const t = r.blocks[0];
    expect(cellsOf(rowsOf(t)[0])[0].attrs).toMatchObject({ rowspan: 2 });
    expect(cellsOf(rowsOf(t)[2])[0].attrs).toMatchObject({ rowspan: 1 });
    // the last row's continuation has no restart above it: it stays a cell
    expect(rowsOf(t)[3].content).toHaveLength(2);
  });

  it('a row with fewer cells than the grid declares keeps its cells in their own columns', async () => {
    const r = await readInline(
      tbl(grid(1500, 1500, 1500, 1500),
        tr(tc(p('a')) + tc(p('b')) + tc(p('c')) + tc(p('d'))) +
        tr(tc(p('e')) + tc(p('f')))),
    );
    const t = r.blocks[0];
    expect(rowsOf(t)[1].content).toHaveLength(2);
    expect(cellsOf(rowsOf(t)[1]).map(c => c.attrs!.colwidth)).toEqual([[100], [100]]);
    expect(gridOf(t, 4)[1]).toEqual(['e', 'f', '', '']);
  });

  it('gridBefore moves the row\'s first cell to the right grid column', async () => {
    const r = await readInline(
      tbl(grid(1500, 3000, 4500),
        tr(tc(p('a')) + tc(p('b')) + tc(p('c'))) +
        tr(tc(p('d')) + tc(p('e')), '<w:gridBefore w:val="1"/>')),
    );
    const t = r.blocks[0];
    expect(cellsOf(rowsOf(t)[1]).map(c => c.attrs!.colwidth)).toEqual([[200], [300]]);
    expect(r.report.counts.tableLayout).toBe(1);
  });

  it('a vMerge in the second column is matched by its grid column, so the row below keeps its first cell where it is', async () => {
    const r = await readInline(
      tbl(grid(1500, 3000),
        tr(tc(p('a')) + tc(p('b'), restart)) +
        tr(tc(p('c')) + tc('<w:p/>', cont))),
    );
    const t = r.blocks[0];
    expect(cellsOf(rowsOf(t)[0])[1].attrs).toMatchObject({ rowspan: 2 });
    expect(cellTexts(rowsOf(t)[1])).toEqual(['c']);
    expect(gridOf(t, 2)).toEqual([['a', 'b'], ['c', 'b']]);
  });

  it('a row whose every cell is folded into the rows above stays a row, with no cells', async () => {
    const r = await readInline(tbl(grid(1000), tr(tc(p('A'), restart)) + tr(tc('<w:p/>', cont)) + tr(tc(p('B')))));
    const t = r.blocks[0];
    expect(rowsOf(t)).toHaveLength(3);
    expect(cellsOf(rowsOf(t)[1])).toHaveLength(0);
    expect(cellsOf(rowsOf(t)[0])[0].attrs).toMatchObject({ rowspan: 2 });
    expect(gridOf(t, 1)).toEqual([['A'], ['A'], ['B']]);
    expect(() => getSpecSchema().nodeFromJSON(r.doc).check()).not.toThrow();
  });

  it('a gridSpan wider than the grid keeps the cell and has no colwidth', async () => {
    const r = await readInline(tbl(grid(1500, 1500), tr(tc(p('wide'), span(4)))));
    const cell = cellsOf(rowsOf(r.blocks[0])[0])[0];
    expect(cell.attrs).toMatchObject({ colspan: 4, colwidth: null });
    expect(textOf(cell)).toBe('wide');
  });

  it('a table without a tblGrid still reads, without colwidth', async () => {
    const r = await readInline(tbl('', tr(tc(p('a')) + tc(p('b')))));
    expect(cellsOf(rowsOf(r.blocks[0])[0]).map(c => c.attrs!.colwidth)).toEqual([null, null]);
    expect(rowsOf(r.blocks[0]).map(cellTexts)).toEqual([['a', 'b']]);
  });

  it('only the leading rows marked tblHeader are header rows (as Word repeats them)', async () => {
    const r = await readInline(
      tbl(grid(1000), tr(tc(p('h1')), '<w:tblHeader/>') + tr(tc(p('h2')), '<w:tblHeader/>') + tr(tc(p('body'))) + tr(tc(p('late')), '<w:tblHeader/>')),
    );
    expect(rowsOf(r.blocks[0]).map(row => cellsOf(row)[0].type)).toEqual(['tableHeader', 'tableHeader', 'tableCell', 'tableCell']);
  });

  it('tblHeader w:val="0" is not a header row', async () => {
    const r = await readInline(tbl(grid(1000), tr(tc(p('x')), '<w:tblHeader w:val="0"/>')));
    expect(cellsOf(rowsOf(r.blocks[0])[0])[0].type).toBe('tableCell');
  });
});

describe('tables: properties the model cannot hold are recorded, never silently dropped', () => {
  const layoutWarnings = (r: Awaited<ReturnType<typeof readDocument>>) => r.report.warnings.filter(w => w.feature === 'tableLayout');

  it('an absurd gridSpan is clamped to the widest Word allows, the cell and its text kept', async () => {
    const r = await readInline(tbl(grid(1000), tr(tc(p('huge'), span(500000)))));
    const cell = cellsOf(rowsOf(r.blocks[0])[0])[0];
    expect(cell.attrs).toMatchObject({ colspan: 63, colwidth: null });
    expect(textOf(cell)).toBe('huge');
    expect(r.report.counts.tableLayout).toBe(1);
  });

  it('legacy hMerge cells stay separate cells', async () => {
    const r = await readInline(tbl(grid(1000, 1000), tr(tc(p('a'), '<w:hMerge w:val="restart"/>') + tc(p('b'), '<w:hMerge/>'))));
    expect(rowsOf(r.blocks[0]).map(cellTexts)).toEqual([['a', 'b']]);
    expect(layoutWarnings(r).map(w => w.category)).toEqual([2]);
  });

  it('a floating table, row exceptions, property revisions and cell revisions are each recorded, and the text stays', async () => {
    const r = await readInline(
      tbl(grid(1000), tr('<w:tblPrEx><w:tblW w:w="1" w:type="dxa"/></w:tblPrEx>' + tc(p('x'), '<w:cellIns w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z"/>')), '<w:tblpPr w:leftFromText="100"/><w:tblPrChange w:id="2" w:author="A" w:date="2026-01-01T00:00:00Z"><w:tblPr/></w:tblPrChange>'),
    );
    expect(textOf(r.blocks[0])).toBe('x');
    // three kinds of thing, each recorded once per table: floating, row exception, and tracked formatting changes (table-level and cell-level share one)
    expect(r.report.counts.tableLayout).toBe(3);
    expect(layoutWarnings(r)).toHaveLength(3);
  });

  it('reading a table does not change the XML it was read from', async () => {
    const data = await inline(tbl(grid(1000, 1000), tr(tc(p('a'), restart) + tc(p('b'))) + tr(tc('<w:p/>', cont) + tc(p('c')))));
    const pkg = await openPackage(data);
    const before = new XMLSerializer().serializeToString(pkg.xml(mainDocumentPart(pkg))!);
    const r = await readDocument(data);
    expect(r.blocks[0].type).toBe('table');
    expect(new XMLSerializer().serializeToString(r.pkg.xml(mainDocumentPart(r.pkg))!)).toBe(before);
  });
});

describe('tables: empty cells, nested tables, table positions', () => {
  it('a cell with no paragraph at all gets one empty paragraph (a cell cannot be empty in the model)', async () => {
    const r = await readInline(tbl(grid(1000, 1000), tr(tc('') + tc(p('x')))));
    const cell = cellsOf(rowsOf(r.blocks[0])[0])[0];
    expect(cell.content).toEqual([expect.objectContaining({ type: 'paragraph' })]);
    expect(() => getSpecSchema().nodeFromJSON(r.doc).check()).not.toThrow();
  });

  it('a cell holding only a table is that table and nothing else', async () => {
    const inner = tbl(grid(500), tr(tc(p('inner only'))));
    const r = await readInline(tbl(grid(1000), tr(tc(inner))));
    const cell = cellsOf(rowsOf(r.blocks[0])[0])[0];
    expect(cell.content!.map(x => x.type)).toEqual(['table']);
    expect(textOf(cell)).toBe('inner only');
    expect(isBlockUntouched(cell.content![0])).toBe(true);
    expect(() => getSpecSchema().nodeFromJSON(r.doc).check()).not.toThrow();
  });

  it('a table that ends the document is read and nothing follows it', async () => {
    const r = await readInline(p('lead') + tbl(grid(1000), tr(tc(p('last')))));
    expect(r.blocks.map(b => b.type)).toEqual(['paragraph', 'table']);
    expect(textOf(r.blocks[1])).toBe('last');
  });

  it('two tables back to back stay two tables, in order', async () => {
    const r = await readInline(tbl(grid(1000), tr(tc(p('one')))) + tbl(grid(1000), tr(tc(p('two')))));
    expect(r.blocks.map(b => b.type)).toEqual(['table', 'table']);
    expect(r.blocks.map(textOf)).toEqual(['one', 'two']);
    expect(blockIdOf(r.blocks[0])).not.toBe(blockIdOf(r.blocks[1]));
  });

  it('a table with no rows is kept whole as an opaque block, never dropped, and counts nothing for content it no longer shows', async () => {
    const r = await readInline(p('before') + `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="1000"/></w:tblGrid>${goog(9, '')}</w:tbl>` + p('after'));
    expect(r.report.counts.googleWrapper).toBeUndefined();
    expect(r.report.counts.table).toBeUndefined();
    expect(r.blocks.map(b => b.type)).toEqual(['paragraph', 'opaqueBlock', 'paragraph']);
    expect(r.ctx.preservation.fragments[r.blocks[1].attrs!.fragmentId as string].xml).toContain('tblGrid');
    expect(r.report.warnings.some(w => w.feature === 'table')).toBe(true);
  });

  it('a very deep nesting stops at a limit and keeps the rest whole as an opaque block, without a stack overflow', async () => {
    let xml = tbl(grid(1000), tr(tc(p('deepest'))));
    for (let i = 0; i < 40; i++) xml = tbl(grid(1000), tr(tc(xml)));
    const r = await readInline(xml);
    expect(all(r.blocks, n => n.type === 'table').length).toBeGreaterThan(5);
    expect(all(r.blocks, n => n.type === 'table').length).toBeLessThan(41);
    expect(all(r.blocks, n => n.type === 'opaqueBlock')).toHaveLength(1);
    expectTextConserved(r, [r.body.getElementsByTagNameNS(W_NS, 'tbl')[0]]);
    expect(() => getSpecSchema().nodeFromJSON(r.doc).check()).not.toThrow();
  });

  it('nesting inside a nested table: every paragraph at every depth keeps its own provenance', async () => {
    const level3 = tbl(grid(500), tr(tc(p('three'))));
    const level2 = tbl(grid(800), tr(tc(p('two') + level3)));
    const r = await readInline(tbl(grid(1000), tr(tc(p('one') + level2))));
    const paragraphs = all(r.blocks, n => n.type === 'paragraph');
    expect(paragraphs.map(textOf)).toEqual(['one', 'two', 'three']);
    for (const para of paragraphs) {
      expect(isBlockUntouched(para), textOf(para)).toBe(true);
      expect(r.ctx.preservation.blocks[blockIdOf(para)].xml).toContain(textOf(para));
    }
    const tables = all(r.blocks, n => n.type === 'table');
    expect(tables).toHaveLength(3);
    for (const t of tables) expect(isBlockUntouched(t)).toBe(true);
    expect(new Set([...paragraphs, ...tables].map(blockIdOf)).size).toBe(6);
  });
});

describe('tables: cell content other than plain paragraphs', () => {
  it('groups a numbered list inside a cell into an orderedList, per cell', async () => {
    const r = await readInline(tbl(grid(4000), tr(tc(p('intro') + li('step one', 2) + li('step two', 2) + p('after')))));
    const cell = cellsOf(rowsOf(r.blocks[0])[0])[0];
    expect(cell.content!.map(x => x.type)).toEqual(['paragraph', 'orderedList', 'paragraph']);
    expect(cell.content![1].content!.map(textOf)).toEqual(['step one', 'step two']);
    expect(r.report.counts.list).toBe(1);
    for (const para of all([cell], n => n.type === 'paragraph')) expect(isBlockUntouched(para)).toBe(true);
  });

  it('a bulleted list in a cell is a bulletList and a list in a nested table is grouped too', async () => {
    const inner = tbl(grid(1000), tr(tc(li('in nested', 1) + li('also', 1))));
    const r = await readInline(tbl(grid(2000, 2000), tr(tc(li('bullet', 1)) + tc(inner))));
    expect(all(r.blocks, n => n.type === 'bulletList')).toHaveLength(2);
    expect(r.report.counts.list).toBe(2);
  });

  it('a list that continues across two cells restarts in the second one: recorded as a category-2 approximation', async () => {
    const r = await readInline(tbl(grid(2000, 2000), tr(tc(li('first', 2) + li('second', 2)) + tc(li('third', 2) + li('fourth', 2)))));
    const lists = all(r.blocks, n => n.type === 'orderedList');
    expect(lists).toHaveLength(2);
    expect(lists[1].attrs!.start).toBe(1); // Word shows 3.; the model starts again at 1
    expect(r.report.counts.complexNumbering).toBe(1);
    const w = r.report.warnings.filter(x => x.feature === 'complexNumbering');
    expect(w).toHaveLength(1);
    expect(w[0].category).toBe(2);
    expect(w[0].message).toMatch(/table cell/i);
  });

  it('numbering that merely shares a numId with a list in ANOTHER table is flagged, and unrelated lists are not', async () => {
    const r = await readInline(
      tbl(grid(2000), tr(tc(li('a1', 2)))) + tbl(grid(2000), tr(tc(li('b1', 2)))) + tbl(grid(2000), tr(tc(li('c1', 1)))),
    );
    expect(r.report.counts.complexNumbering).toBe(1); // table 2 continues table 1's count; the bullet list in table 3 has none
  });

  it('a numbered list and a bullet list in one cell are not a continuation', async () => {
    const r = await readInline(tbl(grid(2000), tr(tc(li('only one', 2) + p('break') + li('other numbering', 1)))));
    expect(r.report.counts.complexNumbering ?? 0).toBe(0);
  });

  it('a Google Docs wrapper around a paragraph in a cell is unwrapped and counted', async () => {
    const r = await readInline(tbl(grid(2000), tr(tc(goog(1, p('wrapped')) + p('plain')))));
    const cell = cellsOf(rowsOf(r.blocks[0])[0])[0];
    expect(cell.content!.map(textOf)).toEqual(['wrapped', 'plain']);
    expect(r.report.counts.googleWrapper).toBe(1);
  });

  it('a Google Docs wrapper around a cell or a row is unwrapped too', async () => {
    const r = await readInline(tbl(grid(1000, 1000), goog(2, tr(goog(3, tc(p('c1'))) + tc(p('c2'))))));
    expect(rowsOf(r.blocks[0]).map(cellTexts)).toEqual([['c1', 'c2']]);
    expect(r.report.counts.googleWrapper).toBe(2);
  });

  it('an ordinary content control around a cell shows its content and warns that the control is not kept as a unit', async () => {
    const sdt = `<w:sdt><w:sdtPr><w:alias w:val="Picker"/></w:sdtPr><w:sdtContent>${tc(p('controlled'))}</w:sdtContent></w:sdt>`;
    const r = await readInline(tbl(grid(1000, 1000), tr(sdt + tc(p('c2')))));
    expect(rowsOf(r.blocks[0]).map(cellTexts)).toEqual([['controlled', 'c2']]);
    expect(r.report.counts.tableLayout).toBe(1);
    expect(r.report.warnings.some(w => w.feature === 'tableLayout' && /content control/i.test(w.message))).toBe(true);
  });

  it('a content control around a paragraph inside a cell is an opaque block, as in the body', async () => {
    const sdt = `<w:sdt><w:sdtPr><w:alias w:val="Picker"/></w:sdtPr><w:sdtContent>${p('kept whole')}</w:sdtContent></w:sdt>`;
    const r = await readInline(tbl(grid(2000), tr(tc(p('before') + sdt))));
    const cell = cellsOf(rowsOf(r.blocks[0])[0])[0];
    expect(cell.content!.map(x => x.type)).toEqual(['paragraph', 'opaqueBlock']);
    expect(cell.content![1].attrs).toMatchObject({ kind: 'contentControl' });
    expectTextConserved(r, Array.from(r.body.getElementsByTagNameNS(W_NS, 'tbl')));
  });

  it('a bookmark between paragraphs in a cell is kept as an opaque block', async () => {
    const r = await readInline(tbl(grid(2000), tr(tc(p('one') + '<w:bookmarkStart w:id="1" w:name="mark"/>' + p('two') + '<w:bookmarkEnd w:id="1"/>'))));
    const cell = cellsOf(rowsOf(r.blocks[0])[0])[0];
    expect(cell.content!.map(x => x.type)).toEqual(['paragraph', 'opaqueBlock', 'paragraph', 'opaqueBlock']);
    expect(r.report.counts.bookmark).toBe(2);
  });

  it('a bookmark or comment range between rows and cells is not in the model but is counted as an approximation', async () => {
    const r = await readInline(
      tbl(grid(1000), '<w:bookmarkStart w:id="2" w:name="rowmark"/>' + tr('<w:commentRangeStart w:id="3"/>' + tc(p('x')) + '<w:commentRangeEnd w:id="3"/>')),
    );
    expect(rowsOf(r.blocks[0]).map(cellTexts)).toEqual([['x']]);
    expect(r.report.counts.tableLayout).toBe(1);
    expect(r.ctx.preservation.blocks[blockIdOf(r.blocks[0])].xml).toContain('rowmark');
  });

  it('a tracked insertion in a cell paragraph stays an atom with its fragment (text conserved)', async () => {
    const ins = '<w:ins w:id="9" w:author="A" w:date="2026-01-01T00:00:00Z"><w:r><w:t>added words</w:t></w:r></w:ins>';
    const r = await readInline(tbl(grid(2000), tr(tc(`<w:p><w:r><w:t>kept </w:t></w:r>${ins}</w:p>`))));
    expect(r.report.counts.trackedChange).toBe(1);
    expectTextConserved(r, Array.from(r.body.getElementsByTagNameNS(W_NS, 'tbl')));
  });

  it('a tracked row insertion or deletion is shown as an ordinary row and recorded', async () => {
    const r = await readInline(tbl(grid(1000), tr(tc(p('new row')), '<w:ins w:id="4" w:author="A" w:date="2026-01-01T00:00:00Z"/>')));
    expect(textOf(r.blocks[0])).toBe('new row');
    expect(r.report.counts.tableLayout).toBe(1);
  });

  it('shading and cell borders are recorded as table borders too, once per table', async () => {
    const r = await readInline(
      tbl(grid(1000, 1000), tr(tc(p('a'), '<w:shd w:val="clear" w:fill="DDDDDD"/>') + tc(p('b'), '<w:tcBorders><w:top w:val="single" w:sz="4"/></w:tcBorders>'))),
    );
    expect(r.report.counts.tableBorders).toBe(1);
  });

  it('a table with no borders or shading is not recorded as a border approximation', async () => {
    const r = await readInline(tbl(grid(1000), tr(tc(p('a')))));
    expect(r.report.counts.tableBorders).toBeUndefined();
    expect(r.report.counts.table).toBe(1);
  });

  it('a nested table\'s borders are recorded for the nested table, not the outer one', async () => {
    const inner = tbl(grid(500), tr(tc(p('in'))), '<w:tblBorders><w:top w:val="single" w:sz="4"/></w:tblBorders>');
    const r = await readInline(tbl(grid(1000), tr(tc(inner))));
    expect(r.report.counts.tableBorders).toBe(1);
    const [outer, nested] = all(r.blocks, n => n.type === 'table');
    expect(r.ctx.preservation.blocks[blockIdOf(nested)].xml).toContain('tblBorders');
    // the outer table's own fragment contains the nested one's XML, because it contains the nested table
    expect(r.ctx.preservation.blocks[blockIdOf(outer)].xml).toContain('tblBorders');
  });
});

describe('tables: heading inference sees the grouped document, tables included', () => {
  it('a candidate index is a position in the document that holds the table', async () => {
    const r = await readInline(
      p('Intro line that is just ordinary text of some length so it is plain body text.') +
        p('Results', '', '<w:b/>') +
        p('Knockdown reduced the response by half in every line tested, in two independent experiments.') +
        tbl(grid(1000, 1000), tr(tc(p('t1')) + tc(p('t2')))) +
        p('Discussion', '', '<w:b/>') +
        p('These data suggest a conserved mechanism that deserves further study in other tissues.'),
    );
    expect(r.blocks.map(b => b.type)).toEqual(['paragraph', 'paragraph', 'paragraph', 'table', 'paragraph', 'paragraph']);
    const found = inferHeadings(r.doc, r.ctx);
    expect(found.map(c => [c.index, c.text])).toEqual([[1, 'Results'], [4, 'Discussion']]);
    for (const c of found) expect(textOf(r.blocks[c.index]).trim()).toBe(c.text);
  });

  it('bold text inside a table cell is never proposed as a heading', async () => {
    const r = await readInline(
      p('Results', '', '<w:b/>') + p('Knockdown reduced the response by half in every line tested, in two independent experiments.') +
        tbl(grid(1000), tr(tc(p('Methods', '', '<w:b/>')))) +
        p('Discussion', '', '<w:b/>') + p('These data suggest a conserved mechanism that deserves further study in other tissues.'),
    );
    const found = inferHeadings(r.doc, r.ctx);
    expect(found.map(c => c.text)).toEqual(['Results', 'Discussion']);
  });
});

// ─── review round 1 ─────────────────────────────────────────────────────────────────────────────────────────────

const REV = 'w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z"';

describe('tables: every property the model cannot hold is recorded with its own message', () => {
  const oneCell = (tcPr = '', trPr = '', tblPr = '', gridXml = grid(1000)) => tbl(gridXml, tr(tc(p('x'), tcPr), trPr), tblPr);
  const layout = (r: Awaited<ReturnType<typeof readDocument>>) => r.report.warnings.filter(w => w.feature === 'tableLayout');

  const cases: Array<[string, () => string, RegExp]> = [
    ['gridBefore', () => oneCell('', '<w:gridBefore w:val="1"/>'), /gridBefore/],
    ['gridAfter', () => oneCell('', '<w:gridAfter w:val="1"/>'), /gridAfter/],
    ['row insertion', () => oneCell('', `<w:ins ${REV}/>`), /whole table row/],
    ['row deletion', () => oneCell('', `<w:del ${REV}/>`), /whole table row/],
    ['trPrChange', () => oneCell('', `<w:trPrChange ${REV}><w:trPr/></w:trPrChange>`), /formatting/],
    ['cellIns', () => oneCell(`<w:cellIns ${REV}/>`), /formatting/],
    ['cellDel', () => oneCell(`<w:cellDel ${REV}/>`), /formatting/],
    ['cellMerge', () => oneCell(`<w:cellMerge ${REV} w:vMerge="rest"/>`), /formatting/],
    ['tcPrChange', () => oneCell(`<w:tcPrChange ${REV}><w:tcPr/></w:tcPrChange>`), /formatting/],
    ['tblPrChange', () => oneCell('', '', `<w:tblPrChange ${REV}><w:tblPr/></w:tblPrChange>`), /formatting/],
    ['tblGridChange', () => oneCell('', '', '', `<w:tblGrid><w:gridCol w:w="1000"/><w:tblGridChange ${REV}><w:tblGrid/></w:tblGridChange></w:tblGrid>`), /formatting/],
    ['tblPrEx', () => tbl(grid(1000), tr('<w:tblPrEx><w:tblW w:w="1" w:type="dxa"/></w:tblPrEx>' + tc(p('x')))), /tblPrEx/],
    ['floating table', () => oneCell('', '', '<w:tblpPr w:leftFromText="100"/>'), /floating table/],
    ['legacy hMerge', () => oneCell('<w:hMerge w:val="restart"/>'), /hMerge/],
    ['oversized gridSpan', () => oneCell('<w:gridSpan w:val="64"/>'), /more grid columns than Word allows/],
    ['content control around a cell', () => tbl(grid(1000), tr(`<w:sdt><w:sdtPr/><w:sdtContent>${tc(p('x'))}</w:sdtContent></w:sdt>`)), /content control/],
    ['bookmark between rows', () => tbl(grid(1000), '<w:bookmarkStart w:id="2" w:name="m"/>' + tr(tc(p('x')))), /Markup between/],
    ['comment range between cells', () => tbl(grid(1000), tr('<w:commentRangeStart w:id="3"/>' + tc(p('x')))), /Markup between/],
    ['orphan continuation', () => tbl(grid(1000), tr(tc('<w:p/>', cont))), /no matching cell above/],
    ['continuation with content', () => tbl(grid(1000), tr(tc(p('top'), restart)) + tr(tc(p('hidden'), cont))), /content that Word does not show/],
  ];
  it.each(cases)('%s: one category-2 tableLayout record with its own message', async (_name, xml, message) => {
    const r = await readInline(xml());
    expect(r.blocks[0].type).toBe('table');
    expect(r.report.counts.tableLayout).toBe(1);
    expect(layout(r)).toHaveLength(1);
    expect(layout(r)[0].category).toBe(2);
    expect(layout(r)[0].message).toMatch(message);
    expectTextConserved(r, Array.from(r.body.getElementsByTagNameNS(W_NS, 'tbl')));
  });

  it('the orphan and the hidden-content messages are different', async () => {
    const a = layout(await readInline(tbl(grid(1000), tr(tc('<w:p/>', cont)))))[0].message;
    const b = layout(await readInline(tbl(grid(1000), tr(tc(p('top'), restart)) + tr(tc(p('hidden'), cont)))))[0].message;
    expect(a).not.toBe(b);
  });

  const borderCases: Array<[string, string, string, string]> = [
    ['table-level shd', '', '', '<w:shd w:val="clear" w:fill="DDDDDD"/>'],
    ['tblBorders', '', '', '<w:tblBorders><w:top w:val="single" w:sz="4"/></w:tblBorders>'],
    ['cell-level shd alone', '<w:shd w:val="clear" w:fill="DDDDDD"/>', '', ''],
    ['tcBorders alone', '<w:tcBorders><w:top w:val="single" w:sz="4"/></w:tcBorders>', '', ''],
  ];
  it.each(borderCases)('%s alone is recorded once as a category-2 table border/shading approximation', async (_n, tcPr, trPr, tblPr) => {
    const r = await readInline(oneCell(tcPr, trPr, tblPr));
    expect(r.report.counts.tableBorders).toBe(1);
    expect(r.report.warnings.filter(w => w.feature === 'tableBorders').map(w => w.category)).toEqual([2]);
    expect(r.report.counts.tableLayout).toBeUndefined();
  });

  it('a gridCol with width 0 gives no colwidth for the columns it covers, and the next column keeps its own', async () => {
    const r = await readInline(tbl(grid(0, 1500), tr(tc(p('a')) + tc(p('b')))));
    expect(cellsOf(rowsOf(r.blocks[0])[0]).map(c => c.attrs!.colwidth)).toEqual([null, [100]]);
  });

  it('a continuation cell carrying only proofErr, or only an empty run with lastRenderedPageBreak, is blank and folds', async () => {
    const proof = '<w:p><w:proofErr w:type="spellStart"/><w:proofErr w:type="spellEnd"/></w:p>';
    const rendered = '<w:p><w:pPr><w:rPr/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:lastRenderedPageBreak/></w:r></w:p>';
    for (const blank of [proof, rendered]) {
      const r = await readInline(tbl(grid(1000), tr(tc(p('top'), restart)) + tr(tc(blank, cont))));
      expect(cellsOf(rowsOf(r.blocks[0])[0])[0].attrs).toMatchObject({ rowspan: 2 });
      expect(r.report.counts.tableLayout).toBeUndefined();
    }
  });

  it('an ordered list inside a nested table is not mistaken for a continuation by the outer cell', async () => {
    const inner = tbl(grid(1000), tr(tc(li('inner one', 2) + li('inner two', 2))));
    const r = await readInline(tbl(grid(3000), tr(tc(p('outer') + inner))));
    expect(all(r.blocks, n => n.type === 'orderedList')).toHaveLength(1);
    expect(r.report.counts.complexNumbering).toBeUndefined();
  });
});

describe('tables: structureHash separates "the table was edited" from "the table changed shape"', () => {
  const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
  const prov = (t: JSONContent) => t.attrs!.ooxml as { blockId: string; sourceHash: string; structureHash: string };

  it('is stored on every table, nested ones included, and matches the table as read', async () => {
    const r = await readDocument(load('tables.docx'));
    const tables = all(r.blocks, n => n.type === 'table');
    expect(tables).toHaveLength(2);
    for (const t of tables) {
      expect(prov(t).structureHash).toMatch(/^[0-9a-f]{14}$/);
      expect(structureHash(t)).toBe(prov(t).structureHash);
    }
    expect(prov(tables[0]).structureHash).not.toBe(prov(tables[1]).structureHash);
    expect(all(r.blocks, n => n.type === 'paragraph').every(x => !('structureHash' in (x.attrs!.ooxml as object)))).toBe(true);
  });

  it('a text-only edit in a cell keeps the structure hash and changes the content hash', async () => {
    const r = await readDocument(load('tables.docx'));
    const table = r.blocks.find(b => b.type === 'table')!;
    const edited = clone(table);
    const para = all([edited], n => n.type === 'paragraph').find(x => textOf(x) === 'r1 c4')!;
    para.content = [{ type: 'text', text: 'r1 c4 edited' }];
    expect(isBlockUntouched(edited)).toBe(false);
    expect(blockHash(edited)).not.toBe(prov(table).sourceHash);
    expect(structureHash(edited)).toBe(prov(table).structureHash);
    // the edited paragraph is no longer untouched, the others still are
    const untouched = all([edited], n => n.type === 'paragraph').filter(isBlockUntouched);
    expect(untouched).toHaveLength(all([table], n => n.type === 'paragraph').length - 1);
  });

  it('a text edit inside a NESTED table, and a paragraph added to or removed from a cell, keep the structure hash', async () => {
    const r = await readDocument(load('tables.docx'));
    const table = r.blocks.find(b => b.type === 'table')!;
    const edited = clone(table);
    all([edited], n => n.type === 'paragraph').find(x => textOf(x) === 'nested 3')!.content = [{ type: 'text', text: 'changed' }];
    expect(structureHash(edited)).toBe(prov(table).structureHash);
    const withExtra = clone(table);
    const cell = all([withExtra], n => n.type === 'tableCell').find(c => textOf(c) === 'r1 c4')!;
    cell.content!.push({ type: 'paragraph', content: [{ type: 'text', text: 'new line' }] });
    expect(structureHash(withExtra)).toBe(prov(table).structureHash);
    const fewer = clone(table);
    const two = all([fewer], n => n.type === 'tableCell').find(c => textOf(c).startsWith('r2 c2'))!;
    two.content = [two.content![0]];
    expect(structureHash(fewer)).toBe(prov(table).structureHash);
  });

  it('adding or removing a row, a cell, or a nested row changes it; so does a span, a width or header-ness', async () => {
    const r = await readDocument(load('tables.docx'));
    const table = r.blocks.find(b => b.type === 'table')!;
    const h = prov(table).structureHash;
    const addRow = clone(table);
    addRow.content!.push(clone(addRow.content![addRow.content!.length - 1]));
    expect(structureHash(addRow)).not.toBe(h);
    const dropRow = clone(table);
    dropRow.content!.pop();
    expect(structureHash(dropRow)).not.toBe(h);
    const dropCell = clone(table);
    dropCell.content![0].content!.pop();
    expect(structureHash(dropCell)).not.toBe(h);
    const nestedRow = clone(table);
    all([nestedRow], n => n.type === 'table')[1].content!.pop();
    expect(structureHash(nestedRow)).not.toBe(h);
    const colspan = clone(table);
    all([colspan], n => n.type === 'tableCell')[0].attrs!.colspan = 2;
    expect(structureHash(colspan)).not.toBe(h);
    const rowspan = clone(table);
    all([rowspan], n => n.type === 'tableCell')[0].attrs!.rowspan = 3;
    expect(structureHash(rowspan)).not.toBe(h);
    const width = clone(table);
    all([width], n => n.type === 'tableCell')[0].attrs!.colwidth = [999];
    expect(structureHash(width)).not.toBe(h);
    const header = clone(table);
    header.content![1].content![0].type = 'tableHeader';
    expect(structureHash(header)).not.toBe(h);
  });

  it('survives schema normalization and a JSON round trip', async () => {
    const r = await readDocument(load('tables.docx'));
    const back = getSpecSchema().nodeFromJSON(r.doc).toJSON() as JSONContent;
    const t = back.content!.find(b => b.type === 'table')!;
    expect(prov(t).structureHash).toBe(prov(r.blocks[1]).structureHash);
    expect(structureHash(t)).toBe(prov(t).structureHash);
  });
});

// The abandoned-read path (rollback of blocks, fragments, counts, warnings and comment ids) is unreachable from XML: both reachable
// abandon paths (depth limit, no rows) return before the read has taken an id. It is forced, with a mocked schema failure, in
// tables.fallback.test.ts.
describe('tables: shared state', () => {
  it('numbering is parsed once for tables and body together: a damaged numbering part warns once', async () => {
    const r = await readDocument(await inline(tbl(grid(1000), tr(tc(p('a')))) + tbl(grid(1000), tr(tc(p('b')))) + p('c'), '<w:numbering xmlns:w="x"'));
    expect(r.report.warnings.filter(w => /numbering\.xml could not be read/.test(w.message))).toHaveLength(1);
  });

  it('a table-heavy document reads in linear time (12000 one-cell tables)', async () => {
    const one = tbl(grid(1000), tr(tc(p('x'))));
    const started = Date.now();
    const r = await readInline(one.repeat(12000));
    expect(r.blocks).toHaveLength(12000);
    expect(Date.now() - started).toBeLessThan(8000);
  }, 60000);
});

describe('tables: what structureHash does and does not promise', () => {
  const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
  const stored = (t: JSONContent) => (t.attrs!.ooxml as { structureHash: string }).structureHash;
  const paragraphsOf = (n: JSONContent) => all([n], x => x.type === 'paragraph');

  it('a paragraph moved from one cell to another leaves the hash unchanged although every paragraph is still untouched', async () => {
    const r = await readInline(tbl(grid(1000, 1000), tr(tc(p('moves') + p('stays')) + tc(p('other')))));
    const t = r.blocks[0];
    const moved = clone(t);
    const [c1, c2] = cellsOf(rowsOf(moved)[0]);
    c2.content!.push(c1.content!.shift()!);
    expect(rowsOf(moved).map(cellTexts)).not.toEqual(rowsOf(t).map(cellTexts));
    expect(structureHash(moved)).toBe(stored(t));
    expect(paragraphsOf(moved).every(isBlockUntouched)).toBe(true);
    expect(isBlockUntouched(moved)).toBe(false); // the content hash does notice
  });

  it('reversing the blocks of a cell, and swapping two rows of identical shape, also leave the hash unchanged', async () => {
    const r = await readInline(tbl(grid(1000), tr(tc(p('one') + p('two') + p('three'))) + tr(tc(p('row a'))) + tr(tc(p('row b')))));
    const t = r.blocks[0];
    const reversed = clone(t);
    cellsOf(rowsOf(reversed)[0])[0].content!.reverse();
    expect(structureHash(reversed)).toBe(stored(t));
    const swapped = clone(t);
    [swapped.content![1], swapped.content![2]] = [swapped.content![2], swapped.content![1]];
    expect(structureHash(swapped)).toBe(stored(t));
    expect(paragraphsOf(swapped).every(isBlockUntouched)).toBe(true);
    // so the hash alone is NOT enough to patch edits into the old cells: the writer rebuilds each cell's blocks from the model
    expect(rowsOf(swapped).map(cellTexts)).toEqual([['one' + 'two' + 'three'], ['row b'], ['row a']]);
  });

  it('replacing a cell\'s content with a list and a heading leaves the hash unchanged', async () => {
    const r = await readInline(tbl(grid(1000), tr(tc(p('plain')))));
    const t = r.blocks[0];
    const swapped = clone(t);
    cellsOf(rowsOf(swapped)[0])[0].content = [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'H' }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }] }] },
    ];
    expect(structureHash(swapped)).toBe(stored(t));
  });

  it('swapping a nested table and a paragraph inside a cell leaves the hash unchanged', async () => {
    const r = await readInline(tbl(grid(2000), tr(tc(p('lead') + tbl(grid(500), tr(tc(p('in'))))))));
    const t = r.blocks[0];
    const swapped = clone(t);
    cellsOf(rowsOf(swapped)[0])[0].content!.reverse();
    expect(cellsOf(rowsOf(swapped)[0])[0].content![0].type).toBe('table');
    expect(structureHash(swapped)).toBe(stored(t));
  });
});

describe('tables: bounded work', () => {
  it('reading paragraphs and tables never scans the preservation maps (counted, not timed)', async () => {
    let scans = 0;
    const counting = <T extends object>(o: T): T =>
      new Proxy(o, {
        ownKeys(target) {
          scans++;
          return Reflect.ownKeys(target);
        },
      });
    const store = emptyPreservationStore();
    store.blocks = counting(store.blocks);
    store.fragments = counting(store.fragments);
    const ins = '<w:ins w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z"><w:r><w:t>added</w:t></w:r></w:ins>';
    const bodyXml =
      p('a') + `<w:p><w:r><w:t>b</w:t></w:r>${ins}<w:bookmarkStart w:id="1" w:name="m"/></w:p>` +
      tbl(grid(1000, 1000), tr(tc(`<w:p><w:r><w:t>c</w:t></w:r>${ins}</w:p>` + tbl(grid(500), tr(tc(p('d'))))) + tc(p('e')))) +
      '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="1000"/></w:tblGrid></w:tbl>' + // rowless: abandoned after it was started, so rollbackPoint's closure runs
      p('f');
    const r = await readDocument(await inline(bodyXml), store);
    const scansWhileReading = scans;
    expect(r.blocks.map(b => b.type)).toEqual(['paragraph', 'paragraph', 'table', 'opaqueBlock', 'paragraph']);
    expect(Object.keys(r.ctx.preservation.fragments).length).toBeGreaterThanOrEqual(3);
    expect(scansWhileReading).toBe(0);
  });
});

describe('tables: rarely-hit guards', () => {
  it('gridBefore is clamped to exactly 63 columns (the widest grid Word allows)', async () => {
    // column i is (i + 1) px wide, so the width the cell gets names the column it starts in
    const widths = Array.from({ length: 100 }, (_, i) => (i + 1) * 15);
    const r = await readInline(tbl(grid(...widths), tr(tc(p('x')), '<w:gridBefore w:val="500"/>')));
    expect(cellsOf(rowsOf(r.blocks[0])[0])[0].attrs!.colwidth).toEqual([64]); // starts at column 63 (0-based), not 500 and not 99
  });

  it('a second tblGrid is ignored: the first one gives the widths', async () => {
    const r = await readInline(`<w:tbl><w:tblPr/>${grid(1500)}${grid(3000)}${tr(tc(p('x')))}</w:tbl>`);
    expect(cellsOf(rowsOf(r.blocks[0])[0])[0].attrs!.colwidth).toEqual([100]);
  });
});
