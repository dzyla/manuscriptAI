import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
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
const readLists = (name: string) => readListsFrom(load(name));

async function readListsFrom(data: ArrayBuffer) {
  const pkg = await openPackage(data);
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


// ─── inline packages: one numbering definition set, a body written per test ─────────────────────────────────────

const WNS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const lvlXml = (ilvl: number, fmt: string, text: string, left: number | null, extra = '') =>
  `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/>${extra}<w:lvlText w:val="${text}"/>${left === null ? '' : `<w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr>`}</w:lvl>`;
const INLINE_NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${WNS}">
<w:abstractNum w:abstractNumId="0">${lvlXml(0, 'bullet', '•', 720)}${lvlXml(1, 'bullet', 'o', 1440)}</w:abstractNum>
<w:abstractNum w:abstractNumId="1">${lvlXml(0, 'decimal', '%1.', 720)}${lvlXml(1, 'lowerLetter', '%2.', 1440)}${lvlXml(2, 'lowerRoman', '%3.', 2160)}</w:abstractNum>
<w:abstractNum w:abstractNumId="2">${lvlXml(0, 'decimal', '%1.', null)}</w:abstractNum>
<w:abstractNum w:abstractNumId="3">${lvlXml(0, 'decimal', '%1.', 720)}${lvlXml(1, 'lowerLetter', '%2.', 1440, '<w:lvlRestart w:val="0"/>')}</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
<w:num w:numId="3"><w:abstractNumId w:val="1"/></w:num>
<w:num w:numId="4"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>
<w:num w:numId="5"><w:abstractNumId w:val="2"/></w:num>
<w:num w:numId="6"><w:abstractNumId w:val="3"/></w:num>
</w:numbering>`;
const STYLES_INLINE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${WNS}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;
const li = (text: string, numId: number, ilvl: number, bold = false) =>
  `<w:p><w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr><w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t>${text}</w:t></w:r></w:p>`;
const pl = (text: string, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`;

async function inline(bodyXml: string, numberingXml: string | null = INLINE_NUMBERING): Promise<ArrayBuffer> {
  const zip = new JSZip();
  const ct = 'application/vnd.openxmlformats-officedocument.wordprocessingml';
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${ct}.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="${ct}.styles+xml"/>${numberingXml ? `<Override PartName="/word/numbering.xml" ContentType="${ct}.numbering+xml"/>` : ''}</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RNS}/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RNS}/styles" Target="styles.xml"/>${numberingXml ? `<Relationship Id="rId2" Type="${RNS}/numbering" Target="numbering.xml"/>` : ''}</Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="${WNS}"><w:body>${bodyXml}</w:body></w:document>`);
  zip.file('word/styles.xml', STYLES_INLINE);
  if (numberingXml) zip.file('word/numbering.xml', numberingXml);
  return zip.generateAsync({ type: 'arraybuffer' });
}
const readInline = async (bodyXml: string, numberingXml?: string | null) => readListsFrom(await inline(bodyXml, numberingXml));
/** A compact picture of a list tree: "ol[a, b, ul[c]]" (items' first paragraph; nested lists inline). */
const shape = (n: JSONContent): string =>
  isList(n)
    ? `${n.type === 'orderedList' ? 'ol' : 'ul'}[${(n.content ?? []).map(item => (item.content ?? []).map(c => (isList(c) ? shape(c) : textOf(c))).join(' ')).join(', ')}]`
    : textOf(n);

describe('readNumbering', async () => {
  const pkg = await openPackage(load('lists.docx'));
  const report = createReport();
  const map: NumberingMap = readNumbering(pkg, report);

  it('reads every w:num with the ordered flag, format and start of each level', () => {
    expect([...map.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(map.get(7)!.hasOverride).toBe(true);
    expect(map.get(2)!.hasOverride).toBe(false);
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

  it('joins an unnumbered List Continue paragraph (no indent at all) to the item above it', () => {
    const items = itemsOf(listWith(r.blocks, 'Item with two paragraphs'));
    expect(items).toHaveLength(2);
    expect(items[1].content!.map(textOf)).toEqual(['Next item', 'Style continuation of that item.']);
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

describe('inline cases: continuation, nesting shapes and Word counting rules', () => {
  const warn = (r: Awaited<ReturnType<typeof readInline>>, re: RegExp) => r.report.warnings.some(w => w.feature === 'complexNumbering' && re.test(w.message));

  it('I1: a bullet list reused after body text adds no complexNumbering; a numbered one does, exactly once', async () => {
    const bullets = await readInline(li('b1', 1, 0) + pl('body') + li('b2', 1, 0) + pl('body') + li('b3', 1, 0));
    expect(bullets.blocks.map(shape)).toEqual(['ul[b1]', 'body', 'ul[b2]', 'body', 'ul[b3]']);
    expect(bullets.report.counts.complexNumbering).toBeUndefined();
    const numbered = await readInline(li('n1', 2, 0) + pl('body') + li('n2', 2, 0));
    expect(numbered.blocks.map(shape)).toEqual(['ol[n1]', 'body', 'ol[n2]']);
    expect(numbered.blocks[2].attrs!.start).toBe(2);
    expect(numbered.report.counts.complexNumbering).toBe(1);
    expect(warn(numbered, /interrupted/i)).toBe(true);
  });

  it('I2: a paragraph indented to a level that has no w:ind joins the item; one with no indent does not', async () => {
    const r = await readInline(li('item', 5, 0) + pl('indented', '<w:ind w:left="360"/>') + li('next', 5, 0) + pl('flush') + li('after', 5, 0));
    expect(r.blocks.map(shape)).toEqual(['ol[item indented, next]', 'flush', 'ol[after]']);
  });

  it('I2: a paragraph indented LESS than the item text does not join; one indented to it does', async () => {
    const short = await readInline(li('item', 2, 0) + pl('shallow', '<w:ind w:left="360"/>'));
    expect(short.blocks.map(shape)).toEqual(['ol[item]', 'shallow']);
    const deep = await readInline(li('item', 2, 0) + pl('deep', '<w:ind w:left="720"/>') + pl('flush'));
    expect(deep.blocks.map(shape)).toEqual(['ol[item deep]', 'flush']);
  });

  it('I2: a blank paragraph between two numbered items ends the list (and the second list keeps the number)', async () => {
    const r = await readInline(li('one', 2, 0) + pl('') + li('two', 2, 0));
    expect(r.blocks.map(shape)).toEqual(['ol[one]', '', 'ol[two]']);
    expect(r.blocks[2].attrs!.start).toBe(2);
    expect(r.report.warnings.find(w => /interrupted/i.test(w.message))!.message).toMatch(/blank paragraph/);
  });

  it('I3: 0 -> 0 -> 2 -> 1 -> 0 puts a second sibling list in the same listItem as the item above it', async () => {
    const r = await readInline(li('a', 1, 0) + li('b', 1, 0) + li('x', 1, 2) + li('c', 1, 1) + li('d', 1, 0));
    expect(r.blocks.map(shape)).toEqual(['ul[a, b ul[x] ul[c], d]']);
    expect(warn(r, /skips a level/)).toBe(true);
  });

  it('I3: interleaved numIds at one level make separate adjacent lists', async () => {
    const r = await readInline(li('p', 1, 0) + li('q', 2, 0) + li('r', 1, 0));
    expect(r.blocks.map(shape)).toEqual(['ul[p]', 'ol[q]', 'ul[r]']);
    expect(r.blocks.map(b => b.attrs?.wordNumId)).toEqual([1, 2, 1]);
  });

  it('I3: a bullet list nested in a numbered list keeps its own type and numId, and the numbered list carries on after it', async () => {
    const r = await readInline(li('o1', 2, 0) + li('b1', 1, 1) + li('b2', 1, 1) + li('o2', 2, 0));
    expect(r.blocks.map(shape)).toEqual(['ol[o1 ul[b1, b2], o2]']);
    const inner = nestedLists(itemsOf(r.blocks[0])[0])[0];
    expect(inner.type).toBe('bulletList');
    expect(inner.attrs?.wordNumId).toBe(1);
    expect(r.blocks[0].attrs?.start).toBe(1);
    expect(r.report.counts.complexNumbering).toBeUndefined();
  });

  it('I3: a list that ends the document is closed and complete', async () => {
    const r = await readInline(pl('lead') + li('x', 2, 0) + li('y', 2, 1));
    expect(r.blocks.map(shape)).toEqual(['lead', 'ol[x ol[y]]']);
    expect(all(r.blocks, n => n.type === 'paragraph')).toHaveLength(3);
  });

  it('I3: a first item at ilvl 2 followed by shallower items gives three top-level lists in order', async () => {
    const r = await readInline(li('x', 2, 2) + li('y', 2, 1) + li('z', 2, 0));
    expect(r.blocks.map(shape)).toEqual(['ol[x]', 'ol[y]', 'ol[z]']);
    expect(r.blocks[0].attrs).toMatchObject({ type: 'i', start: 1 });
    expect(warn(r, /begins below/)).toBe(true);
    expect(all(r.blocks, n => n.type === 'paragraph').map(textOf)).toEqual(['x', 'y', 'z']);
  });

  it('I4: a second w:num on the same abstractNum continues the count, as Word does', async () => {
    const r = await readInline(li('a', 2, 0) + li('b', 2, 0) + pl('body') + li('c', 3, 0));
    expect(r.blocks.map(shape)).toEqual(['ol[a, b]', 'body', 'ol[c]']);
    expect(r.blocks[2].attrs).toMatchObject({ start: 3, wordNumId: 3 });
    expect(warn(r, /continues earlier numbering/)).toBe(true);
  });

  it('I4: adjacent lists on different numIds that share an abstractNum also continue', async () => {
    const r = await readInline(li('a', 2, 0) + li('b', 3, 0));
    expect(r.blocks.map(shape)).toEqual(['ol[a]', 'ol[b]']);
    expect(r.blocks[1].attrs!.start).toBe(2);
  });

  it('I4: a w:num with a lvlOverride counts on its own, from its startOverride', async () => {
    const r = await readInline(li('a', 2, 0) + li('b', 2, 0) + pl('body') + li('fresh', 4, 0));
    expect(r.blocks[2].attrs).toMatchObject({ start: 1, wordNumId: 4 });
    expect(r.report.counts.complexNumbering).toBeUndefined(); // a fresh count: nothing is continued, so nothing is approximated
  });

  it('I4: w:lvlRestart on a numbered level is reported, not silently ignored', async () => {
    const r = await readInline(li('one', 6, 0) + li('sub', 6, 1));
    expect(warn(r, /lvlRestart/)).toBe(true);
    expect(r.report.counts.complexNumbering).toBe(1);
  });

  it('records a level approximation once per list, not once per item', async () => {
    const odd = INLINE_NUMBERING.replace("w:val=\"lowerLetter\"/><w:lvlText w:val=\"%2.\"", "w:val=\"ordinalText\"/><w:lvlText w:val=\"%2.\"");
    const r = await readInline(li('p', 2, 0) + li('q', 2, 1) + li('r', 2, 1) + li('s', 2, 1), odd);
    expect(r.report.counts.complexNumbering).toBe(1);
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
