/**
 * The schema-failure path of readTable: "cannot happen" for tables this reader builds, so it is forced here by making the schema's
 * normalization throw for the Nth table. The table is then kept whole as a read-only block, and everything the abandoned read
 * registered (blocks, fragments, report counts, warnings, comment ids), nested tables included, must be withdrawn.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import type { JSONContent } from '@tiptap/core';

let tableCalls = 0;
let failTableCall = 0;
let failParagraphs = 0;
vi.mock('../../extensions/schemaSpecs', async importOriginal => {
  const actual = await importOriginal<typeof import('../../extensions/schemaSpecs')>();
  return {
    ...actual,
    specNormalizeNode: (n: { type?: string }) => {
      if (n.type === 'table' && ++tableCalls === failTableCall) throw new Error('forced');
      if (n.type === 'paragraph' && failParagraphs > 0) {
        failParagraphs--;
        throw new Error('forced');
      }
      return actual.specNormalizeNode(n as never);
    },
  };
});

const { openPackage } = await import('./package');
const { readStyles } = await import('./styles');
const { readParagraph, blockChildren } = await import('./paragraphs');
const { readTable } = await import('./tables');
const { createReport } = await import('../fidelity');
const { emptyPreservationStore } = await import('../preserve/types');
const { collectFragmentIds } = await import('../preserve/refs');
const { W_NS, isW } = await import('./ooxml');
const { mainDocumentPart } = await import('./opc');

const WNS = W_NS;
const p = (inner: string) => `<w:p>${inner}</w:p>`;
const t = (text: string) => `<w:r><w:t>${text}</w:t></w:r>`;
const cell = (inner: string) => `<w:tc>${inner}</w:tc>`;
const table = (cells: string) => `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="1000"/></w:tblGrid><w:tr>${cells}</w:tr></w:tbl>`;

async function read(bodyXml: string, preservation = emptyPreservationStore()) {
  const zip = await JSZip.loadAsync(readFileSync(new URL('../../test/fixtures/docx/minimal.docx', import.meta.url)));
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="${WNS}"><w:body>${bodyXml}</w:body></w:document>`);
  const pkg = await openPackage(await zip.generateAsync({ type: 'arraybuffer' }));
  const report = createReport();
  let n = 0;
  const ctx = { pkg, styles: readStyles(pkg, report), report, preservation, assets: [], nextId: () => `id${++n}` };
  const body = pkg.xml(mainDocumentPart(pkg))!.getElementsByTagNameNS(WNS, 'body')[0];
  const blocks = blockChildren(body, ctx).flatMap((el): JSONContent[] => (isW(el, 'p') ? [readParagraph(el, ctx)].flat() : isW(el, 'tbl') ? [readTable(el, ctx)] : []));
  return { ctx, report, blocks, doc: { type: 'doc', content: blocks } as JSONContent };
}

const all = (nodes: JSONContent[], pred: (n: JSONContent) => boolean): JSONContent[] => {
  const out: JSONContent[] = [];
  const walk = (x: JSONContent): void => {
    if (pred(x)) out.push(x);
    (x.content ?? []).forEach(walk);
  };
  nodes.forEach(walk);
  return out;
};

describe('a table that cannot be normalized is abandoned cleanly', () => {
  // the abandoned table: a tracked insertion (a fragment, a count, a warning), a comment anchor, a bookmark, and a nested table with its own paragraph
  const inner = table(cell(p(t('nested text'))));
  const abandoned = table(
    cell(
      p(t('outer text') + '<w:ins w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z"><w:r><w:t>added</w:t></w:r></w:ins>') +
        p('<w:commentRangeStart w:id="9"/>' + t('anchored') + '<w:bookmarkStart w:id="4" w:name="m"/>') +
        inner,
    ),
  );
  const body = p(t('before')) + abandoned + p('<w:commentRangeEnd w:id="9"/>' + t('after'));

  it('keeps the table whole as one opaque block with its text, leaving no orphan block, fragment, count or warning of the abandoned read', async () => {
    tableCalls = 0;
    failTableCall = 2; // call 1 is the nested table (it succeeds and registers its blocks); call 2 is the outer table
    const r = await read(body);
    failTableCall = 0;

    expect(r.blocks.map(b => b.type)).toEqual(['paragraph', 'opaqueBlock', 'paragraph']);
    const kept = r.blocks[1];
    expect(kept.attrs).toMatchObject({ kind: 'unknownField', label: 'table' });
    expect(r.ctx.preservation.fragments[kept.attrs!.fragmentId as string].xml).toContain('nested text');

    // every block and fragment left is referenced by the model: nothing leaked from the outer read or from the nested table inside it
    const blockIds = all(r.blocks, n => !!n.attrs?.ooxml).map(n => (n.attrs!.ooxml as { blockId: string }).blockId);
    expect(Object.keys(r.ctx.preservation.blocks).sort()).toEqual([...blockIds].sort());
    expect(blockIds).toHaveLength(2); // 'before' and 'after'
    expect(Object.keys(r.ctx.preservation.fragments).sort()).toEqual([...collectFragmentIds(r.doc)].sort());

    // counts and warnings: only what the model still shows. The tracked change is inside the kept-whole table, not counted.
    expect(r.report.counts.paragraph).toBe(2);
    // Exactly what the model shows: the default paragraph style (from styles.xml), 2 paragraphs with their 2 runs, the one comment
    // that is still visible (category 1), and two category-3 atoms (the kept-whole table, the surviving comment anchor).
    expect(r.report.counts).toEqual({ paragraphStyle: 1, paragraph: 2, run: 2, comment: 1, unknownField: 2 });
    expect(r.report.byCategory).toEqual({ 1: 6, 2: 0, 3: 2, 4: 0 });
    expect(r.report.counts.table).toBeUndefined();
    expect(r.report.counts.trackedChange).toBeUndefined();
    expect(r.report.counts.bookmark).toBeUndefined();
    expect(r.report.warnings.some(w => w.feature === 'trackedChange')).toBe(false);
    expect(r.report.warnings.some(w => w.feature === 'table' && /could not be represented/.test(w.message))).toBe(true);
  });

  it('forgets the comment ids it counted, so the comment is still counted where it remains visible', async () => {
    tableCalls = 0;
    failTableCall = 2;
    const r = await read(body);
    failTableCall = 0;
    // the anchor in the abandoned table is gone from the model; the end anchor in the paragraph after it is the one that counts
    expect(r.report.counts.comment).toBe(1);
  });

  it('with no failure the same document keeps its table and counts everything', async () => {
    tableCalls = 0;
    failTableCall = 0;
    const r = await read(body);
    expect(r.blocks.map(b => b.type)).toEqual(['paragraph', 'table', 'paragraph']);
    expect(r.report.counts.table).toBe(2);
    expect(r.report.counts.trackedChange).toBe(1);
    expect(r.report.counts.comment).toBe(1);
  });
});

describe('the abandon paths do no map scans (counted, not timed)', () => {
  it('a forced paragraph failure and a forced table failure remove their own entries by id, scanning neither preservation map', async () => {
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
    const ins = (n: number) => `<w:ins w:id="${n}" w:author="A" w:date="2026-01-01T00:00:00Z"><w:r><w:t>added</w:t></w:r></w:ins>`;
    // the first paragraph fails to normalize (its tracked insertion is withdrawn: readParagraph's catch path); the second table
    // fails its 2nd normalization (the outer one, after its nested table succeeded: rollbackPoint's closure with ids to remove)
    const bodyXml =
      p(t('first') + ins(1)) +
      table(cell(p(t('x') + ins(2)) + table(cell(p(t('nested') + ins(3)))))) +
      p(t('last') + ins(4));
    tableCalls = 0;
    failTableCall = 2;
    failParagraphs = 1;
    const r = await read(bodyXml, store);
    failTableCall = 0;
    failParagraphs = 0;
    const scansWhileReading = scans;

    expect(r.blocks.map(b => b.type)).toEqual(['paragraph', 'opaqueBlock', 'paragraph']);
    expect(scansWhileReading).toBe(0);
    // and both paths really ran: the first paragraph kept only its text and has no provenance; the table was kept whole
    expect(r.blocks[0].attrs!.ooxml).toBeNull();
    expect(r.report.warnings.some(w => /A paragraph could not be represented/.test(w.message))).toBe(true);
    expect(r.report.warnings.some(w => w.feature === 'table' && /could not be represented/.test(w.message))).toBe(true);
    // only the last paragraph's insertion and the kept-whole table remain as fragments, only the last paragraph as a block
    expect(Object.keys(r.ctx.preservation.fragments).sort()).toEqual([...collectFragmentIds(r.doc)].sort());
    expect(Object.keys(r.ctx.preservation.blocks)).toHaveLength(1);
  });
});
