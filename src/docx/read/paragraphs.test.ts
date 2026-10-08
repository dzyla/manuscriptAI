import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { JSONContent } from '@tiptap/core';
import { openPackage } from './package';
import { readStyles } from './styles';
import { mainDocumentPart } from './opc';
import { readParagraph, blockChildren, unwrapGoogleSdt, isGoogleSdt } from './paragraphs';
import { readRuns } from './runs';
import type { ReadContext } from './context';
import { createReport } from '../fidelity';
import { emptyPreservationStore } from '../preserve/types';
import { isBlockUntouched } from '../preserve/hash';
import { parseXml } from '../preserve/xml';
import { getSpecSchema } from '../../extensions/schemaSpecs';
import { W_NS, childElements, isW } from './ooxml';

const load = (name: string): ArrayBuffer => {
  const b = readFileSync(new URL(`../../test/fixtures/docx/${name}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

/** Read every body paragraph of a fixture; returns the blocks and the context the reader filled. */
async function readBody(name: string) {
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
  const sources = blockChildren(body, ctx).filter(el => isW(el, 'p'));
  const blocks = sources.flatMap(p => [readParagraph(p, ctx)].flat());
  return { pkg, ctx, report, body, sources, blocks, doc: { type: 'doc', content: blocks } as JSONContent };
}

const textOf = (n: JSONContent): string => (n.type === 'text' ? n.text ?? '' : (n.content ?? []).map(textOf).join(''));
const find = (blocks: JSONContent[], needle: string): JSONContent => {
  const hit = blocks.find(b => textOf(b).includes(needle));
  if (!hit) throw new Error(`no block contains "${needle}"`);
  return hit;
};
const textNode = (block: JSONContent, text: string): JSONContent => {
  const hit = (block.content ?? []).find(c => c.type === 'text' && c.text?.includes(text));
  if (!hit) throw new Error(`no text node contains "${text}"`);
  return hit;
};
const markTypes = (n: JSONContent): string[] => (n.marks ?? []).map(m => m.type).sort();
const mark = (n: JSONContent, type: string) => (n.marks ?? []).find(m => m.type === type);
const descendants = (n: JSONContent, type: string): JSONContent[] =>
  (n.content ?? []).flatMap(c => [...(c.type === type ? [c] : []), ...descendants(c, type)]);

describe('body-basics.docx: paragraphs and styles', async () => {
  const r = await readBody('body-basics.docx');

  it('maps a Heading1 paragraph to a level-1 heading carrying the app style id', () => {
    const h = find(r.blocks, 'Aims Overview');
    expect(h.type).toBe('heading');
    expect(h.attrs).toMatchObject({ level: 1, styleId: 'heading1' });
  });

  it('maps Heading2 to level 2, Normal to a paragraph and Caption to a caption-styled paragraph', () => {
    expect(find(r.blocks, 'Background Section')).toMatchObject({ type: 'heading', attrs: { level: 2, styleId: 'heading2' } });
    expect(find(r.blocks, 'Plain ')).toMatchObject({ type: 'paragraph', attrs: { styleId: 'normal' } });
    expect(find(r.blocks, 'Figure 1. A caption.')).toMatchObject({ type: 'paragraph', attrs: { styleId: 'caption' } });
    expect(r.report.counts.caption).toBe(1);
  });

  it('turns a direct w:outlineLvl into a heading with no style id', () => {
    expect(find(r.blocks, 'outline heading')).toMatchObject({ type: 'heading', attrs: { level: 2, styleId: null } });
  });

  it('leaves an unstyled paragraph with styleId null', () => {
    expect(find(r.blocks, 'styledword').attrs?.styleId).toBeNull();
  });
});

describe('body-basics.docx: runs and marks', async () => {
  const r = await readBody('body-basics.docx');
  const para = find(r.blocks, 'boldword');

  it('puts bold on the bold run only', () => {
    expect(markTypes(textNode(para, 'boldword'))).toEqual(['bold']);
    expect(markTypes(textNode(para, 'Plain '))).toEqual([]);
  });

  it('puts italic, underline and strike on their own runs', () => {
    expect(markTypes(textNode(para, 'italicword'))).toEqual(['italic']);
    expect(markTypes(textNode(para, 'underlineword'))).toEqual(['underline']);
    expect(markTypes(textNode(para, 'strikeword'))).toEqual(['strike']);
  });

  it('treats w:b w:val="0" and w:u none as no formatting', () => {
    expect(markTypes(textNode(para, 'notbold'))).toEqual([]);
  });

  it('turns w:rFonts, w:sz and w:color into fontFamily, fontSize (points) and textColor marks', () => {
    const t = textNode(find(r.blocks, 'styledword'), 'styledword');
    expect(mark(t, 'fontFamily')?.attrs).toEqual({ family: 'Georgia' });
    expect(mark(t, 'fontSize')?.attrs).toEqual({ sizePt: 14 });
    expect(mark(t, 'textColor')?.attrs).toEqual({ color: '#ff0000' });
  });

  it('turns w:vertAlign into superscript and subscript', () => {
    const p = find(r.blocks, 'styledword');
    const subs = (p.content ?? []).filter(c => mark(c, 'subscript'));
    const sups = (p.content ?? []).filter(c => mark(c, 'superscript'));
    expect(subs.map(textOf)).toEqual(['2']);
    expect(sups.map(textOf)).toEqual(['2']);
    expect(subs[0]).not.toBe(sups[0]);
  });

  it('turns w:rStyle into a characterStyle mark carrying the mapped style id', () => {
    const t = textNode(find(r.blocks, 'emphaticword'), 'emphaticword');
    expect(mark(t, 'characterStyle')?.attrs).toEqual({ styleId: 'emphasis' });
  });

  it('turns w:highlight into a highlight mark with a colour', () => {
    const t = textNode(find(r.blocks, 'markedword'), 'markedword');
    expect(mark(t, 'highlight')?.attrs).toEqual({ color: '#ffff00' });
  });

  it('keeps tabs and hard breaks inside a run in order, honours xml:space and trims what Word ignores', () => {
    const p = find(r.blocks, 'lead');
    expect(p.content?.map(c => c.type)).toEqual(['text', 'hardBreak', 'text']);
    // the last run has no xml:space="preserve", so Word ignores its surrounding white space
    expect(textOf(p)).toBe('lead a\tb c -dtrimmed');
  });
});

describe('body-basics.docx: page breaks', async () => {
  const r = await readBody('body-basics.docx');

  it('turns w:br w:type="page" into a pageBreak node', () => {
    const solo = r.blocks.find(b => descendants(b, 'pageBreak').length === 1 && textOf(b) === '')!;
    expect(solo.type).toBe('paragraph');
    expect(solo.content).toEqual([{ type: 'pageBreak' }]);
  });

  it('keeps a paragraph that holds text and a break as ONE node so it keeps its provenance', () => {
    const p = find(r.blocks, 'Before break');
    expect(p.content?.map(c => c.type)).toEqual(['text', 'pageBreak', 'text']);
    expect(textOf(p)).toBe('Before break After break');
    expect(isBlockUntouched(p)).toBe(true);
    expect(r.report.counts.pageBreak).toBe(2);
  });
});

describe('body-basics.docx: hyperlinks', async () => {
  const r = await readBody('body-basics.docx');
  const para = find(r.blocks, 'webcitation');

  it('turns an http hyperlink into a link mark, keeping the run formatting', () => {
    const t = textNode(para, 'webcitation');
    expect(mark(t, 'link')?.attrs).toMatchObject({ href: 'https://example.org/paper' });
    expect(mark(t, 'bold')).toBeDefined();
  });

  it('allows mailto', () => {
    expect(mark(textNode(para, 'mailtolink'), 'link')?.attrs).toMatchObject({ href: 'mailto:author@example.org' });
  });

  it('keeps a file: hyperlink as plain text and warns', () => {
    expect(markTypes(textNode(para, 'filelink'))).toEqual([]);
    expect(r.report.warnings.some(w => w.feature === 'hyperlink' && /file:/.test(w.message))).toBe(true);
  });

  it('keeps a javascript: hyperlink as plain text and warns', () => {
    expect(markTypes(textNode(para, 'scriptlink'))).toEqual([]);
    expect(r.report.warnings.some(w => w.feature === 'hyperlink' && /javascript:/.test(w.message))).toBe(true);
  });

  it('keeps internal anchors, part targets and dangling relationship ids as plain text', () => {
    expect(markTypes(textNode(para, 'anchorlink'))).toEqual([]);
    expect(markTypes(textNode(para, 'internallink'))).toEqual([]);
    expect(markTypes(textNode(para, 'danglinglink'))).toEqual([]);
  });

  it('creates link marks for exactly the two allowed links and counts them', () => {
    const links = (para.content ?? []).filter(c => mark(c, 'link'));
    expect(links.map(textOf)).toEqual(['webcitation', 'mailtolink']);
    expect(r.report.counts.hyperlink).toBe(2);
  });

  it('warns once per reason, not once per link', () => {
    const messages = r.report.warnings.filter(w => w.feature === 'hyperlink').map(w => w.message);
    expect(new Set(messages).size).toBe(messages.length);
  });
});

describe('body-basics.docx: paragraph formatting', async () => {
  const r = await readBody('body-basics.docx');

  it('turns w:jc both into textAlign justify', () => {
    expect(find(r.blocks, 'justified paragraph').attrs?.textAlign).toBe('justify');
  });

  it('carries spacing in points and indents in inches as declared', () => {
    expect(find(r.blocks, 'justified paragraph').attrs).toMatchObject({
      spaceBefore: 12,
      spaceAfter: 6,
      lineSpacing: { rule: 'auto', value: 1.5 },
      indentLeft: 0.5,
      indentFirstLine: 0.25,
    });
  });

  it('reads a hanging indent as a negative first-line indent and an exact line as points', () => {
    expect(find(r.blocks, 'hanging paragraph').attrs).toMatchObject({
      indentLeft: 0.5,
      indentFirstLine: -0.25,
      lineSpacing: { rule: 'exact', value: 14 },
    });
  });

  it('leaves formatting the paragraph does not declare as null', () => {
    expect(find(r.blocks, 'Plain ').attrs).toMatchObject({
      textAlign: null, spaceBefore: null, spaceAfter: null, lineSpacing: null, indentLeft: null, indentFirstLine: null,
    });
  });

  it('records keep rules and tab stops as category 2', () => {
    expect(r.report.counts.keepRules).toBe(1);
    expect(r.report.counts.tabStops).toBe(1);
  });
});

describe('body-basics.docx: nothing the app does not model is dropped', async () => {
  const r = await readBody('body-basics.docx');
  const preserved = (id: string) => r.ctx.preservation.fragments[id];

  it('keeps the text of a w:smartTag wrapper and reports that the wrapper was unwrapped', () => {
    expect(textOf(find(r.blocks, 'Denver'))).toBe('Denver is high.');
    expect(r.report.warnings.some(w => /smartTag/.test(w.message))).toBe(true);
    expect(r.report.byCategory[3] + r.report.warnings.length).toBeGreaterThan(0);
  });

  it('keeps an equation as an opaque atom whose fragment still holds its XML', () => {
    const atom = descendants(find(r.blocks, 'Equation: '), 'opaqueInline')[0];
    expect(atom.attrs).toMatchObject({ kind: 'equation' });
    expect(preserved(atom.attrs!.fragmentId).xml).toContain('x+1');
    expect(textOf(find(r.blocks, 'Equation: '))).toBe('Equation:  after.');
  });

  it('keeps a footnote reference with its run formatting, between the text on either side', () => {
    const p = find(r.blocks, 'See note');
    expect(p.content?.map(c => c.type)).toEqual(['text', 'opaqueInline', 'text']);
    const frag = preserved(p.content![1].attrs!.fragmentId);
    expect(p.content![1].attrs).toMatchObject({ kind: 'footnoteRef' });
    const root = parseXml(frag.xml).documentElement;
    expect(root.namespaceURI).toBe(W_NS);
    expect(root.localName).toBe('r');
    expect(childElements(root).map(c => c.localName)).toEqual(['rPr', 'footnoteReference']);
  });

  it('keeps a tracked insertion as a read-only atom rather than losing or silently accepting it', () => {
    const p = find(r.blocks, 'Revised');
    const atom = descendants(p, 'opaqueInline')[0];
    expect(atom.attrs).toMatchObject({ kind: 'unknownField', label: 'tracked change' });
    expect(preserved(atom.attrs!.fragmentId).xml).toContain('insertedword');
  });

  it('keeps a non-Google content control opaque', () => {
    const p = find(r.blocks, 'Control: ');
    const atom = descendants(p, 'opaqueInline')[0];
    expect(atom.attrs).toMatchObject({ kind: 'contentControl' });
    expect(preserved(atom.attrs!.fragmentId).xml).toContain('controlled');
    expect(r.report.counts.googleWrapper).toBeUndefined();
  });

  it('counts every opaque atom under category 3', () => {
    const atoms = descendants(r.doc, 'opaqueInline');
    expect(atoms).toHaveLength(4);
    expect(r.report.byCategory[3]).toBe(atoms.length);
  });

  it('stores each opaque fragment so it re-parses on its own', () => {
    for (const a of descendants(r.doc, 'opaqueInline')) {
      expect(() => parseXml(preserved(a.attrs!.fragmentId).xml).documentElement.localName).not.toThrow();
    }
  });
});

describe('body-basics.docx: provenance', async () => {
  const r = await readBody('body-basics.docx');

  it('gives every paragraph a blockId and a sourceHash', () => {
    expect(r.blocks).toHaveLength(r.sources.length);
    for (const b of r.blocks) {
      const ooxml = b.attrs?.ooxml as { blockId: string; sourceHash: string };
      expect(ooxml.blockId).toMatch(/^b\d+$/);
      expect(ooxml.sourceHash.length).toBeGreaterThan(0);
    }
  });

  it('every paragraph is untouched immediately after import', () => {
    for (const b of r.blocks) expect(isBlockUntouched(b)).toBe(true);
  });

  it('every paragraph is still untouched after the whole document is normalized by the schema', () => {
    const normalized = getSpecSchema().nodeFromJSON(r.doc);
    normalized.check();
    const json = normalized.toJSON() as JSONContent;
    expect(json.content).toHaveLength(r.blocks.length);
    for (const b of json.content!) expect(isBlockUntouched(b)).toBe(true);
  });

  it('stores each paragraph\'s original XML under its blockId, re-parsable on its own', () => {
    const b = find(r.blocks, 'Aims Overview');
    const frag = r.ctx.preservation.blocks[(b.attrs!.ooxml as { blockId: string }).blockId];
    const root = parseXml(frag.xml).documentElement;
    expect(root.localName).toBe('p');
    expect(root.namespaceURI).toBe(W_NS);
    expect(frag.xml).toContain('Aims Overview');
    // only the namespaces the paragraph uses are declared on the fragment
    expect(Object.keys(frag.nsDecls)).toEqual(['w']);
  });

  it('keeps hyperlink relationship ids in the paragraph fragment', () => {
    const p = find(r.blocks, 'webcitation');
    const frag = r.ctx.preservation.blocks[(p.attrs!.ooxml as { blockId: string }).blockId];
    expect(frag.relIds).toEqual(expect.arrayContaining(['rId10', 'rId11', 'rId12']));
  });

  it('gives an empty paragraph provenance too', () => {
    const empty = r.blocks.find(b => b.type === 'paragraph' && !b.content)!;
    expect(isBlockUntouched(empty)).toBe(true);
  });

  it('assigns every block a distinct id', () => {
    const ids = r.blocks.map(b => (b.attrs!.ooxml as { blockId: string }).blockId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('google-export.docx', async () => {
  const r = await readBody('google-export.docx');

  it('unwraps goog_rdk wrappers: the text appears once, as ordinary text', () => {
    const p = find(r.blocks, 'wrappedonce');
    expect(p.content).toEqual([{ type: 'text', text: 'wrappedonce' }]);
    expect(r.blocks.map(textOf).filter(t => t.includes('wrappedonce'))).toHaveLength(1);
  });

  it('unwraps a wrapper nested inside another, keeping run formatting', () => {
    const p = find(r.blocks, 'wrappedtwice');
    expect(textOf(p)).toBe('outer wrappedtwice');
    expect(markTypes(textNode(p, 'wrappedtwice'))).toEqual(['bold']);
  });

  it('records every unwrapped wrapper as googleWrapper (category 1): three, one of them nested', () => {
    expect(r.report.counts.googleWrapper).toBe(3);
  });

  it('creates no opaque atom for a Google wrapper', () => {
    expect(descendants(r.doc, 'opaqueInline')).toHaveLength(0);
    expect(Object.keys(r.ctx.preservation.fragments)).toHaveLength(0);
    expect(r.report.byCategory[3]).toBe(0);
  });

  it('keeps provenance on wrapped paragraphs and the original XML with its wrappers', () => {
    for (const b of r.blocks) expect(isBlockUntouched(b)).toBe(true);
    const id = (find(r.blocks, 'wrappedonce').attrs!.ooxml as { blockId: string }).blockId;
    expect(r.ctx.preservation.blocks[id].xml).toContain('goog_rdk_0');
  });

  it('leaves the embedded font in the package', () => {
    expect(r.pkg.names()).toContain('word/fonts/font1.odttf');
  });
});

describe('unwrapGoogleSdt', () => {
  const doc = (inner: string) =>
    parseXml(`<w:body xmlns:w="${W_NS}">${inner}</w:body>`).documentElement;
  const sdt = (tag: string, inner: string) =>
    `<w:sdt><w:sdtPr><w:tag w:val="${tag}"/></w:sdtPr><w:sdtContent>${inner}</w:sdtContent></w:sdt>`;

  it('recognises only goog_rdk tags', () => {
    const body = doc(sdt('goog_rdk_9', '') + sdt('other', '') + '<w:sdt><w:sdtContent/></w:sdt>');
    expect(childElements(body).map(isGoogleSdt)).toEqual([true, false, false]);
  });

  it('returns the content of a wrapper and flattens wrappers nested three deep', () => {
    const body = doc(sdt('goog_rdk_0', sdt('goog_rdk_1', sdt('goog_rdk_2', '<w:p/>') + '<w:r/>')));
    let n = 0;
    const out = unwrapGoogleSdt(childElements(body)[0], () => n++);
    expect(out.map(e => e.localName)).toEqual(['p', 'r']);
    expect(n).toBe(3);
  });

  it('leaves a non-Google sdt nested in a Google one as an element to be handled opaquely', () => {
    const body = doc(sdt('goog_rdk_0', sdt('control', '<w:r/>')));
    const out = unwrapGoogleSdt(childElements(body)[0]);
    expect(out).toHaveLength(1);
    expect(out[0].localName).toBe('sdt');
    expect(isGoogleSdt(out[0])).toBe(false);
  });

  it('yields nothing for a wrapper with no content element', () => {
    const body = doc('<w:sdt><w:sdtPr><w:tag w:val="goog_rdk_0"/></w:sdtPr></w:sdt>');
    expect(unwrapGoogleSdt(childElements(body)[0])).toEqual([]);
  });
});

describe('readRuns', async () => {
  it('emits nothing for a paragraph with no content, and does not read w:pPr as content', async () => {
    const r = await readBody('body-basics.docx');
    const p = parseXml(`<w:p xmlns:w="${W_NS}"><w:pPr><w:jc w:val="center"/></w:pPr></w:p>`).documentElement;
    expect(readRuns(p, r.ctx)).toEqual([]);
  });

  it('keeps an element from a foreign namespace as an opaque atom', async () => {
    const r = await readBody('body-basics.docx');
    const p = parseXml(`<w:p xmlns:w="${W_NS}" xmlns:x="urn:x"><x:thing a="1"/></w:p>`).documentElement;
    const out = readRuns(p, r.ctx);
    expect(out).toHaveLength(1);
    expect(out[0].attrs).toMatchObject({ kind: 'unknownField', label: 'thing' });
    expect(r.ctx.preservation.fragments[out[0].attrs!.fragmentId].xml).toContain('urn:x');
  });
});

describe('blockChildren', async () => {
  it('unwraps Google wrappers around block content, counts them, and leaves other sdt blocks for the caller', async () => {
    const r = await readBody('body-basics.docx');
    const sdt = (tag: string, inner: string) =>
      `<w:sdt><w:sdtPr><w:tag w:val="${tag}"/></w:sdtPr><w:sdtContent>${inner}</w:sdtContent></w:sdt>`;
    const body = parseXml(
      `<w:body xmlns:w="${W_NS}">${sdt('goog_rdk_0', '<w:p/>' + sdt('goog_rdk_1', '<w:p/>'))}${sdt('control', '<w:p/>')}<w:tbl/></w:body>`,
    ).documentElement;
    const before = r.report.counts.googleWrapper ?? 0;
    const out = blockChildren(body, r.ctx);
    expect(out.map(e => e.localName)).toEqual(['p', 'p', 'sdt', 'tbl']);
    expect((r.report.counts.googleWrapper ?? 0) - before).toBe(2);
  });
});
