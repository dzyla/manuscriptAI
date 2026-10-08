import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { JSONContent } from '@tiptap/core';
import { openPackage } from './package';
import { readStyles } from './styles';
import { mainDocumentPart } from './opc';
import { readParagraph, blockChildren, paragraphDrafts } from './paragraphs';
import { detectHeadings } from './headings';
import { groupListParagraphs, readNumbering, type NumberingMap } from './numbering';
import type { ReadContext } from './context';
import { createReport, summarizeReport } from '../fidelity';
import { emptyPreservationStore } from '../preserve/types';
import { isBlockUntouched } from '../preserve/hash';
import { getSpecSchema } from '../../extensions/schemaSpecs';
import { W_NS, isW } from './ooxml';

const load = (name: string): ArrayBuffer => {
  const b = readFileSync(new URL(`../../test/fixtures/docx/${name}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

/** Read every body paragraph, then group the list paragraphs the way a body reader will. */
async function readLists(name: string) {
  const pkg = await openPackage(load(name));
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
  const flat = blockChildren(body, ctx).filter(el => isW(el, 'p')).flatMap(p => [readParagraph(p, ctx)].flat());
  const before = JSON.stringify(flat);
  const numbering = readNumbering(pkg, report);
  const blocks = groupListParagraphs(flat.map(node => ({ node })), numbering, ctx);
  return { pkg, ctx, report, numbering, flat, blocks, mutated: JSON.stringify(flat) !== before };
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
const isList = (n: JSONContent): boolean => n.type === 'bulletList' || n.type === 'orderedList';
/** The top-level list whose text contains `needle`. */
const listWith = (blocks: JSONContent[], needle: string): JSONContent => {
  const hit = blocks.find(b => isList(b) && textOf(b).includes(needle));
  if (!hit) throw new Error(`no top-level list contains "${needle}"`);
  return hit;
};
const itemText = (item: JSONContent): string => textOf(item.content![0]);
const itemsOf = (list: JSONContent): JSONContent[] => list.content ?? [];
const nestedLists = (item: JSONContent): JSONContent[] => (item.content ?? []).filter(isList);
const topLevelBlock = (blocks: JSONContent[], needle: string): JSONContent => {
  const hit = blocks.find(b => !isList(b) && textOf(b).includes(needle));
  if (!hit) throw new Error(`no non-list block contains "${needle}"`);
  return hit;
};
const blockIdOf = (n: JSONContent): string => (n.attrs!.ooxml as { blockId: string }).blockId;

describe('readNumbering', async () => {
  const pkg = await openPackage(load('lists.docx'));
  const report = createReport();
  const map: NumberingMap = readNumbering(pkg, report);

  it('reads every w:num with the ordered flag, format and start of each level', () => {
    expect([...map.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(map.get(1)!.levels.get(0)).toMatchObject({ ordered: false, format: 'bullet', start: 1 });
    expect(map.get(1)!.levels.get(1)).toMatchObject({ ordered: false, format: 'bullet' });
    expect(map.get(2)!.levels.get(0)).toMatchObject({ ordered: true, format: 'decimal', start: 1 });
    expect(map.get(2)!.levels.get(1)).toMatchObject({ ordered: true, format: 'lowerLetter' });
    expect(map.get(2)!.levels.get(2)).toMatchObject({ ordered: true, format: 'lowerRoman' });
    expect(map.get(3)!.levels.get(0)!.start).toBe(3);
  });

  it('applies a startOverride to the level it names, without touching the shared abstract definition', () => {
    expect(map.get(7)!.levels.get(0)!.start).toBe(5);
    expect(map.get(2)!.levels.get(0)!.start).toBe(1);
  });

  it('says which part holds the definitions, so a writer can find the untouched original', () => {
    expect(map.part).toBe('word/numbering.xml');
  });

  it('chooses the HTML list type from the Word format and marks formats the model cannot express', () => {
    expect(map.get(2)!.levels.get(1)).toMatchObject({ listType: 'a', exact: true });
    expect(map.get(2)!.levels.get(2)).toMatchObject({ listType: 'i', exact: true });
    expect(map.get(6)!.levels.get(0)).toMatchObject({ listType: 'I', exact: false });
    expect(map.get(6)!.levels.get(1)).toMatchObject({ exact: false });
    expect(map.get(1)!.levels.get(0)!.exact).toBe(true);
    expect(map.get(2)!.levels.get(0)!.exact).toBe(true);
  });

  it('resolves numbering carried by a paragraph style, through basedOn', () => {
    expect(map.styleNumPr.get('ListBullet')).toMatchObject({ numId: 1 });
    expect(map.styleNumPr.get('ListNumber2')).toMatchObject({ numId: 2 });
    expect(map.styleNumPr.has('Normal')).toBe(false);
  });

  it('is an empty map, with no part, for a document that has no numbering part', async () => {
    const minimal = readNumbering(await openPackage(load('minimal.docx')));
    expect(minimal.size).toBe(0);
    expect(minimal.part).toBeNull();
  });
});

describe('lists.docx: grouping numbered paragraphs into lists', async () => {
  const r = await readLists('lists.docx');

  it('does not mutate the paragraphs it is given', () => {
    expect(r.mutated).toBe(false);
  });

  it('builds a two-level bullet list in document order', () => {
    const list = listWith(r.blocks, 'Bullet A');
    expect(list.type).toBe('bulletList');
    const items = itemsOf(list);
    expect(items.map(itemText)).toEqual(['Bullet A', 'Bullet B']);
    const inner = nestedLists(items[0]);
    expect(inner).toHaveLength(1);
    expect(inner[0].type).toBe('bulletList');
    expect(itemsOf(inner[0]).map(itemText)).toEqual(['Bullet A1', 'Bullet A2']);
    expect(nestedLists(items[1])).toEqual([]);
  });

  it('builds a two-level numbered list and chooses orderedList from w:numFmt', () => {
    const list = listWith(r.blocks, 'Step one');
    expect(list.type).toBe('orderedList');
    const items = itemsOf(list);
    expect(items.map(itemText)).toEqual(['Step one', 'Step two']);
    const inner = nestedLists(items[0]);
    expect(inner[0].type).toBe('orderedList');
    expect(inner[0].attrs).toMatchObject({ type: 'a', start: 1 });
    expect(itemsOf(inner[0]).map(itemText)).toEqual(['Step one a', 'Step one b']);
    // the sub-list under the second item restarts at a., it does not continue from the first sub-list
    const second = nestedLists(items[1])[0];
    expect(itemsOf(second).map(itemText)).toEqual(['Step two a']);
    expect(second.attrs?.start).toBe(1);
  });

  it('carries w:start onto the orderedList', () => {
    expect(listWith(r.blocks, 'Third').attrs).toMatchObject({ start: 3, wordNumId: 3 });
    expect(itemsOf(listWith(r.blocks, 'Third')).map(itemText)).toEqual(['Third', 'Fourth']);
    expect(listWith(r.blocks, 'Step one').attrs?.start).toBe(1);
  });

  it('carries the Word numId on every list node, nested ones included', () => {
    expect(listWith(r.blocks, 'Bullet A').attrs?.wordNumId).toBe(1);
    expect(nestedLists(itemsOf(listWith(r.blocks, 'Bullet A'))[0])[0].attrs?.wordNumId).toBe(1);
    expect(listWith(r.blocks, 'Step one').attrs?.wordNumId).toBe(2);
  });

  it('keeps a two-paragraph item as ONE listItem with both paragraphs, and the next item separate', () => {
    const list = listWith(r.blocks, 'Item with two paragraphs');
    const items = itemsOf(list);
    expect(items).toHaveLength(2);
    expect(items[0].content!.map(textOf)).toEqual(['Item with two paragraphs', 'Continuation of that item.']);
    expect(items[0].content!.every(c => c.type === 'paragraph')).toBe(true);
    expect(itemText(items[1])).toBe('Next item');
  });

  it('splits a numbered list interrupted by a plain paragraph into two lists that keep their numbers', () => {
    const first = listWith(r.blocks, 'Resume one');
    const second = listWith(r.blocks, 'Resume three');
    expect(first).not.toBe(second);
    expect(itemsOf(first).map(itemText)).toEqual(['Resume one', 'Resume two']);
    expect(itemsOf(second).map(itemText)).toEqual(['Resume three', 'Resume four']);
    expect(first.attrs).toMatchObject({ wordNumId: 5, start: 1 });
    // Word keeps counting across the interruption, so the second list starts where Word's number was
    expect(second.attrs).toMatchObject({ wordNumId: 5, start: 3 });
    const at = (needle: string) => r.blocks.findIndex(b => textOf(b).includes(needle));
    expect(at('Interrupting paragraph.')).toBe(at('Resume one') + 1);
    expect(at('Resume three')).toBe(at('Interrupting paragraph.') + 1);
    expect(topLevelBlock(r.blocks, 'Interrupting').type).toBe('paragraph');
  });

  it('records the split as complexNumbering (category 2) with a warning', () => {
    expect(r.report.counts.complexNumbering).toBeGreaterThanOrEqual(1);
    expect(r.report.warnings.some(w => w.feature === 'complexNumbering' && w.category === 2 && /interrupted/i.test(w.message))).toBe(true);
  });

  it('does not call a bullet list reused after other text an approximation', () => {
    // numId 1 (bullets) is used in four separate places; none of them is a resumed NUMBERED list
    expect(r.report.warnings.filter(w => w.feature === 'complexNumbering' && /bullet/i.test(w.message))).toEqual([]);
  });

  it('records a format the model cannot express as complexNumbering and still chooses the closest list', () => {
    const list = listWith(r.blocks, 'Roman one');
    expect(list.type).toBe('orderedList');
    expect(list.attrs).toMatchObject({ type: 'I', wordNumId: 6 });
    expect(r.report.warnings.some(w => w.feature === 'complexNumbering' && /ordinalText/.test(w.message))).toBe(true);
    expect(r.report.warnings.some(w => w.feature === 'complexNumbering' && /\(%1\)/.test(w.message))).toBe(true);
  });

  it('puts paragraphs numbered by their STYLE (no direct numPr) into lists, inherited through basedOn', () => {
    expect(listWith(r.blocks, 'Style bullet').type).toBe('bulletList');
    const numbered = listWith(r.blocks, 'Style numbered');
    expect(numbered.type).toBe('orderedList');
    expect(numbered.attrs?.wordNumId).toBe(2);
  });

  it('leaves a numbered heading a heading (its number is Word-generated) and says the number is not shown', () => {
    const h = topLevelBlock(r.blocks, 'Numbered heading text');
    expect(h.type).toBe('heading');
    expect(isBlockUntouched(h)).toBe(true);
    expect(r.report.warnings.some(w => w.feature === 'complexNumbering' && /heading/i.test(w.message))).toBe(true);
  });

  it('keeps a paragraph whose numId is not defined, and one with numId 0, as plain paragraphs', () => {
    expect(topLevelBlock(r.blocks, 'Missing definition').type).toBe('paragraph');
    expect(topLevelBlock(r.blocks, 'Zero numbering').type).toBe('paragraph');
    expect(r.report.warnings.some(w => w.feature === 'complexNumbering' && /not contain/i.test(w.message))).toBe(true);
  });

  it('keeps an item that holds a page break or an opaque atom whole, inside its listItem', () => {
    const list = listWith(r.blocks, 'Item with a break');
    expect(list.attrs).toMatchObject({ wordNumId: 7, start: 5 });
    const [brk, eq] = itemsOf(list);
    expect(brk.content![0].content!.some(c => c.type === 'pageBreak')).toBe(true);
    expect(eq.content![0].content!.some(c => c.type === 'opaqueInline')).toBe(true);
    const fragmentIds = all(r.blocks, n => n.type === 'opaqueInline').map(n => n.attrs!.fragmentId as string);
    expect(fragmentIds.length).toBeGreaterThan(0);
    for (const id of fragmentIds) expect(r.ctx.preservation.fragments[id]).toBeDefined();
  });

  it('nests a level-skipping item one level deep and says so', () => {
    const list = listWith(r.blocks, 'Skips down');
    const inner = nestedLists(itemsOf(list)[0]);
    expect(inner).toHaveLength(1);
    expect(itemsOf(inner[0]).map(itemText)).toEqual(['Deep item']);
    expect(r.report.warnings.some(w => w.feature === 'complexNumbering' && /skip/i.test(w.message))).toBe(true);
  });

  it('shows a list that starts below its first level as a top-level list and says so', () => {
    const list = listWith(r.blocks, 'Starts indented');
    expect(list.type).toBe('orderedList');
    expect(r.report.warnings.some(w => w.feature === 'complexNumbering' && /begins below/i.test(w.message))).toBe(true);
  });

  it('records lists as a category-1 feature, once per top-level list, and the summary says so', () => {
    const topLists = r.blocks.filter(isList).length;
    expect(topLists).toBeGreaterThan(8);
    expect(r.report.counts.list).toBe(topLists);
    expect(summarizeReport(r.report)).toContain(`${topLists} lists`);
  });

  it('never drops or duplicates a paragraph: every source paragraph appears exactly once, in order', () => {
    const paragraphsOut = all(r.blocks, n => n.type === 'paragraph' || n.type === 'heading');
    expect(paragraphsOut).toHaveLength(r.flat.length);
    const idsOut = paragraphsOut.map(blockIdOf);
    expect(idsOut).toEqual(r.flat.map(blockIdOf));
    expect(new Set(idsOut).size).toBe(idsOut.length);
  });

  it('keeps each paragraph exactly as read: provenance intact and isBlockUntouched true inside its listItem', () => {
    const inLists = all(r.blocks.filter(isList), n => n.type === 'paragraph');
    expect(inLists.length).toBeGreaterThan(20);
    const byId = new Map(r.flat.map(n => [blockIdOf(n), n]));
    for (const p of inLists) {
      expect(isBlockUntouched(p), textOf(p)).toBe(true);
      expect(p).toEqual(byId.get(blockIdOf(p)));
      expect(r.ctx.preservation.blocks[blockIdOf(p)]).toBeDefined();
    }
  });

  it('gives a two-paragraph item two distinct block ids, both untouched; the continuation is unnumbered in the source', () => {
    const item = itemsOf(listWith(r.blocks, 'Item with two paragraphs'))[0];
    const ids = item.content!.map(blockIdOf);
    expect(new Set(ids).size).toBe(2);
    expect(item.content!.every(isBlockUntouched)).toBe(true);
    expect(r.ctx.preservation.blocks[ids[0]].xml).toContain('numPr');
    expect(r.ctx.preservation.blocks[ids[1]].xml).not.toContain('numPr');
  });

  it('produces a document the schema accepts, and normalization keeps provenance and list attributes', () => {
    const doc = getSpecSchema().nodeFromJSON({ type: 'doc', content: r.blocks });
    expect(() => doc.check()).not.toThrow();
    const normalized = doc.toJSON() as JSONContent;
    expect(all(normalized.content!, n => n.type === 'paragraph').every(isBlockUntouched)).toBe(true);
    expect(listWith(normalized.content!, 'Third').attrs).toMatchObject({ start: 3, wordNumId: 3 });
  });

  it('keeps the original <w:numPr> of every list paragraph in preservation.blocks, and the definitions in the package', () => {
    const numbered = all(r.blocks, n => n.type === 'paragraph').filter(p => r.ctx.preservation.blocks[blockIdOf(p)].xml.includes('numPr'));
    expect(numbered.length).toBeGreaterThan(20);
    expect(r.numbering.part).toBe('word/numbering.xml');
    expect(r.pkg.entry('word/numbering.xml')).toContain('w:abstractNum');
  });
});

describe('list grouping and heading inference', async () => {
  const r = await readLists('lists.docx');
  const draftsOf = (blocks: JSONContent[]) =>
    paragraphDrafts(blocks, { format: r.ctx.styles.format, styleIdByWordId: r.ctx.styles.styleIdByWordId, blocks: r.ctx.preservation.blocks });

  it('a bold list item is not offered as a section title once the lists are grouped (it would be, flat)', () => {
    const flatFound = detectHeadings(draftsOf(r.flat), { hasRealHeadings: false, bodyFontSizePt: 11 });
    expect(flatFound.some(c => c.text === 'Specific Aims')).toBe(true);

    const groupedDrafts = draftsOf(r.blocks);
    const groupedFound = detectHeadings(groupedDrafts, { hasRealHeadings: false, bodyFontSizePt: 11 });
    expect(groupedFound.some(c => c.text === 'Specific Aims')).toBe(false);
    // list items are not top-level paragraphs, so no draft is made of one
    expect(groupedDrafts.some(d => d.text === 'Specific Aims')).toBe(false);
    // the indices a candidate carries are positions in the grouped content
    for (const c of groupedFound) expect(r.blocks[c.index].type).toBe('paragraph');
  });
});

describe('documents without lists', () => {
  it('returns the very same paragraph objects, and records neither list nor complexNumbering', async () => {
    const r = await readLists('body-basics.docx');
    expect(r.blocks).toHaveLength(r.flat.length);
    r.blocks.forEach((b, i) => expect(b).toBe(r.flat[i]));
    expect(r.report.counts.list).toBeUndefined();
    expect(r.report.counts.complexNumbering).toBeUndefined();
  });
});
