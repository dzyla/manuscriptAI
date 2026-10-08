import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { JSONContent } from '@tiptap/core';
import { openPackage } from './package';
import { readStyles } from './styles';
import { mainDocumentPart } from './opc';
import { readParagraph, blockChildren, paragraphDrafts } from './paragraphs';
import { detectHeadings, applyHeadings, inferHeadings, hasHeadings, KNOWN_SECTIONS, type HeadingCandidate } from './headings';
import type { ReadContext } from './context';
import { createReport, summarizeReport, FIDELITY } from '../fidelity';
import { emptyPreservationStore } from '../preserve/types';
import { isBlockUntouched, stampProvenance } from '../preserve/hash';
import { getSpecSchema, specNormalizeNode } from '../../extensions/schemaSpecs';
import { createFormat } from '../../services/formatPresets';
import { W_NS, isW } from './ooxml';

const load = (name: string): ArrayBuffer => {
  const b = readFileSync(new URL(`../../test/fixtures/docx/${name}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

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
  return { ctx, report, blocks, doc: { type: 'doc', content: blocks } as JSONContent };
}

const textOf = (n: JSONContent): string => (n.type === 'text' ? n.text ?? '' : (n.content ?? []).map(textOf).join(''));
const indexOf = (blocks: JSONContent[], starts: string): number => {
  const i = blocks.findIndex(b => textOf(b).startsWith(starts));
  if (i < 0) throw new Error(`no block starts with "${starts}"`);
  return i;
};
const detect = (blocks: JSONContent[], hasRealHeadings = false) =>
  detectHeadings(paragraphDrafts(blocks), { hasRealHeadings, bodyFontSizePt: 11 });
const byText = (found: HeadingCandidate[], text: string) => found.find(c => c.text === text);

describe('unstyled-sections.docx: headings inferred from formatting and section names', async () => {
  const r = await readBody('unstyled-sections.docx');
  const found = detect(r.blocks);

  it('the document really has no heading nodes', () => {
    expect(r.blocks.filter(b => b.type === 'heading')).toHaveLength(0);
    expect(hasHeadings(r.doc)).toBe(false);
  });

  it('detects "Specific Aims" as a level-1 name match whose evidence names the section', () => {
    const c = byText(found, 'Specific Aims');
    expect(c).toMatchObject({ level: 1, confidence: 'name', index: indexOf(r.blocks, 'Specific Aims') });
    expect(c!.evidence.join(' | ')).toContain('Specific Aims');
  });

  it('strips the "A." enumerator before matching "A. Significance", and keeps the paragraph text as written', () => {
    const c = byText(found, 'A. Significance');
    expect(c).toMatchObject({ level: 1, confidence: 'name' });
    expect(c!.evidence.join(' | ')).toMatch(/enumerator/i);
    expect(c!.evidence.join(' | ')).toContain('Significance');
  });

  it('detects "Vertebrate Animals" (an NIH attachment section) even with a trailing unbolded space', () => {
    expect(byText(found, 'Vertebrate Animals')).toMatchObject({ level: 1, confidence: 'name' });
  });

  it('does not detect "Approach" when body text follows in the same paragraph', () => {
    expect(found.some(c => c.index === indexOf(r.blocks, 'Approach'))).toBe(false);
  });

  it('does not detect a bold sentence in the middle of a paragraph', () => {
    expect(found.some(c => c.index === indexOf(r.blocks, 'Earlier work'))).toBe(false);
  });

  it('does not detect a bold line of 14 words', () => {
    expect(found.some(c => c.index === indexOf(r.blocks, 'The overall objective'))).toBe(false);
  });

  it('detects "Aim 1: ..." as an aim title, one level below, even though it is just a short bold line', () => {
    const c = byText(found, 'Aim 1: Define the mechanism');
    expect(c).toMatchObject({ level: 2, confidence: 'aim' });
    expect(c!.evidence.join(' | ')).toMatch(/aim title/i);
    // the evidence names the heading it was placed under: the nearest preceding level-1 heading
    expect(c!.evidence.join(' | ')).toContain('A. Significance');
  });

  it('detects a line set entirely in a larger font than the document default', () => {
    const c = byText(found, 'Timeline of Experiments');
    // "Timeline" alone is a known section, but this line has more words, so it is a pure format match.
    expect(c).toMatchObject({ confidence: 'format' });
    expect(c!.evidence.join(' | ')).toMatch(/larger font/i);
  });

  it('does not take a figure label for a heading', () => {
    expect(found.some(c => c.index === indexOf(r.blocks, 'Figure 1'))).toBe(false);
  });

  it('detects a title led by a page break, because the break is not text', () => {
    expect(byText(found, 'Results')).toMatchObject({ level: 1, confidence: 'name' });
  });

  it('allows a comment anchor around a title but refuses any other opaque atom', () => {
    expect(byText(found, 'Innovation')).toMatchObject({ confidence: 'name' });
    // a bookmark and a tracked insertion each hold an opaque atom
    expect(found.some(c => c.index === indexOf(r.blocks, 'Discussion'))).toBe(false);
    expect(found.some(c => c.index === indexOf(r.blocks, 'Conclusion'))).toBe(false);
  });

  it('every candidate carries evidence, a level of 1-3 and a distinct paragraph index', () => {
    expect(found.length).toBeGreaterThan(0);
    for (const c of found) {
      expect(c.evidence.length).toBeGreaterThan(0);
      expect(c.evidence.every(e => e.trim().length > 0)).toBe(true);
      expect([1, 2, 3]).toContain(c.level);
    }
    expect(new Set(found.map(c => c.index)).size).toBe(found.length);
    // and the list is in document order
    expect(found.map(c => c.index)).toEqual([...found.map(c => c.index)].sort((a, b) => a - b));
  });

  it('returns [] for a document that already uses real heading styles, whatever it looks like', () => {
    expect(detect(r.blocks, true)).toEqual([]);
  });

  it('computes hasRealHeadings from the paragraphs actually read, not from the styles that merely exist', async () => {
    const styled = await readBody('body-basics.docx');
    expect(hasHeadings(styled.doc)).toBe(true);
    expect(inferHeadings(styled.doc, styled.ctx)).toEqual([]);
    // the unstyled fixture's styles.xml DOES define Heading1/2, yet nothing uses them
    expect(r.ctx.styles.headingLevelByStyleId.size).toBeGreaterThan(0);
    expect(inferHeadings(r.doc, r.ctx).length).toBe(found.length);
  });

  it('records each candidate and warns exactly once, in the import report', async () => {
    const fresh = await readBody('unstyled-sections.docx');
    const warningsBefore = fresh.report.warnings.length;
    const got = inferHeadings(fresh.doc, fresh.ctx);
    expect(fresh.report.counts.inferredHeading).toBe(got.length);
    const added = fresh.report.warnings.slice(warningsBefore).filter(w => w.feature === 'inferredHeading');
    expect(added).toHaveLength(1);
    expect(added[0].message).toContain(String(got.length));
    expect(added[0].category).toBe(FIDELITY.inferredHeading);
    expect(summarizeReport(fresh.report)).toMatch(/warning/);
  });

  it('records nothing and warns nothing when it finds nothing', async () => {
    const styled = await readBody('body-basics.docx');
    const before = JSON.stringify(styled.report);
    inferHeadings(styled.doc, styled.ctx);
    expect(JSON.stringify(styled.report)).toBe(before); // nothing was suppressed either, so the report stays quiet
  });
});

describe('detectHeadings: rules on hand-built paragraphs', () => {
  const para = (text: string, opts: { bold?: boolean; sizePt?: number; extra?: JSONContent[]; attrs?: Record<string, unknown> } = {}): JSONContent => {
    const marks: JSONContent['marks'] = [
      ...(opts.bold ? [{ type: 'bold' }] : []),
      ...(opts.sizePt ? [{ type: 'fontSize', attrs: { sizePt: opts.sizePt } }] : []),
    ];
    return {
      type: 'paragraph',
      attrs: { styleId: null, ...opts.attrs },
      content: [{ type: 'text', text, ...(marks.length ? { marks } : {}) }, ...(opts.extra ?? [])],
    };
  };
  const body = (text = 'Plain body text that goes on for a while and ends properly.') => para(text);

  it('allows a trailing colon, and a period only after a known section name', () => {
    expect(detect([para('Specific Aims:', { bold: true }), body()])).toHaveLength(1);
    // real grants write "B. INNOVATION." and "C. APPROACH."
    const named = detect([para('B. INNOVATION.', { bold: true }), body()]);
    expect(named).toHaveLength(1);
    expect(named[0].confidence).toBe('name');
    expect(named[0].evidence.join(' | ')).toMatch(/trailing period/i);
    // ...but a bold line that merely looks like a title is a sentence once it ends in a period
    expect(detect([para('A short bold line.', { bold: true }), body()])).toHaveLength(0);
  });

  it('never accepts a question or an exclamation, even after a known section name', () => {
    expect(detect([para('Specific Aims?', { bold: true }), body()])).toHaveLength(0);
    expect(detect([para('Specific Aims!', { bold: true }), body()])).toHaveLength(0);
    expect(detect([para('Is it bold?', { bold: true }), body()])).toHaveLength(0);
  });

  it('reads a multi-part enumerator as depth: "C.1." and "2.1" are at least level 2, "1.2.3" level 3', () => {
    const lvl = (t: string) => detect([para(t, { bold: true }), body()])[0];
    expect(lvl('C.1. Preliminary data')).toMatchObject({ confidence: 'name', level: 2 });
    expect(lvl('C.1. Preliminary data').evidence.join(' | ')).toMatch(/2 parts/);
    expect(lvl('2.1 Current state of research')).toMatchObject({ confidence: 'format', level: 2 });
    expect(lvl('1.2.3 Current state of research')).toMatchObject({ level: 3 });
    expect(lvl('A. Significance')).toMatchObject({ level: 1 });
    expect(lvl('2. Current state of research')).toMatchObject({ level: 1 });
  });

  it('a body paragraph set larger than the body size is not a "body" for the line above it', () => {
    const big = (t: string) => para(t, { sizePt: 16 });
    // a document whose body is 16 pt but whose docDefaults are 11 pt: nothing should look like a heading
    expect(detect([big('Some short line'), big('Another short line'), big('A last short line')])).toHaveLength(0);
  });

  it('strips A. / 1. / 1.1 / I. / (a) enumerators before matching a known name', () => {
    for (const t of ['A. Approach', '1. Approach', '1.1 Approach', 'I. Approach', '(a) Approach', 'B) Approach']) {
      const got = detect([para(t, { bold: true }), body()]);
      expect(got, t).toHaveLength(1);
      expect(got[0].confidence, t).toBe('name');
    }
  });

  it('does not treat a leading article as an enumerator', () => {
    expect(detect([para('A Approach', { bold: true }), body()])[0]?.confidence).not.toBe('name');
  });

  it('matches case-insensitively and across spacing and slash variants', () => {
    expect(detect([para('PROJECT SUMMARY / ABSTRACT', { bold: true }), body()])[0]).toMatchObject({ confidence: 'name', level: 1 });
    expect(detect([para('Project  Summary/Abstract', {}), body()])[0]).toMatchObject({ confidence: 'name' });
    expect(detect([para('Materials and Methods', {}), body()])[0]).toMatchObject({ confidence: 'name' });
  });

  it('names a plain, unformatted one-line paragraph that is a known section name', () => {
    expect(detect([para('Introduction'), body()])[0]).toMatchObject({ confidence: 'name', level: 1 });
  });

  it('makes Significance / Innovation / Approach level 2 only under a Research Strategy heading', () => {
    const under = detect([para('Research Strategy', { bold: true }), body(), para('Significance', { bold: true }), body(), para('Approach', { bold: true }), body()]);
    expect(under.map(c => [c.text, c.level])).toEqual([['Research Strategy', 1], ['Significance', 2], ['Approach', 2]]);
    const alone = detect([para('Significance', { bold: true }), body(), para('Approach', { bold: true }), body()]);
    expect(alone.map(c => c.level)).toEqual([1, 1]);
  });

  it('a later top-level section ends the Research Strategy scope', () => {
    const got = detect([para('Research Strategy', { bold: true }), body(), para('Significance', { bold: true }), body(), para('Vertebrate Animals', { bold: true }), body(), para('Approach', { bold: true }), body()]);
    expect(got.map(c => c.level)).toEqual([1, 2, 1, 1]);
  });

  it('refuses a format match that is not followed by a non-bold paragraph', () => {
    expect(detect([para('A short bold line', { bold: true })])).toHaveLength(0);
    expect(detect([para('A short bold line', { bold: true }), para('Another bold line', { bold: true })])).toHaveLength(0);
  });

  it('looks past blank paragraphs when asking what follows', () => {
    const blank: JSONContent = { type: 'paragraph', attrs: { styleId: null } };
    expect(detect([para('A short bold line', { bold: true }), blank, body()])).toHaveLength(1);
  });

  it('refuses a format match of more than 8 words but allows a name match of up to 10', () => {
    expect(detect([para('one two three four five six seven eight nine', { bold: true }), body()])).toHaveLength(0);
    expect(detect([para('one two three four five six seven eight', { bold: true }), body()])).toHaveLength(1);
    expect(detect([para('Authentication of Key Biological and/or Chemical Resources', { bold: true }), body()])).toHaveLength(1);
  });

  it('refuses a format match that is only partly bold', () => {
    const mixed: JSONContent = { type: 'paragraph', attrs: { styleId: null }, content: [{ type: 'text', text: 'Part ', marks: [{ type: 'bold' }] }, { type: 'text', text: 'plain' }] };
    expect(detect([mixed, body()])).toHaveLength(0);
  });

  it('refuses a paragraph with a line break, which is not a single line', () => {
    const two: JSONContent = { type: 'paragraph', attrs: { styleId: null }, content: [{ type: 'text', text: 'Specific Aims', marks: [{ type: 'bold' }] }, { type: 'hardBreak' }, { type: 'text', text: 'and more', marks: [{ type: 'bold' }] }] };
    expect(detect([two, body()])).toHaveLength(0);
  });

  it('a larger-font line needs a known default size; without one only bold counts', () => {
    const big = para('Some Title Here', { sizePt: 16 });
    expect(detect([big, body()])[0]?.evidence.join(' ')).toMatch(/larger font/i);
    expect(detectHeadings(paragraphDrafts([big, body()]), { hasRealHeadings: false })).toHaveLength(0);
    expect(detect([para('Some Title Here', { sizePt: 11 }), body()])).toHaveLength(0);
  });

  it('skips a paragraph already styled as a caption', () => {
    expect(detect([para('Short caption', { bold: true, attrs: { styleId: 'caption' } }), body()])).toHaveLength(0);
  });

  it('does not touch a node that is already a heading', () => {
    const h: JSONContent = { type: 'heading', attrs: { level: 2, styleId: null }, content: [{ type: 'text', text: 'Specific Aims', marks: [{ type: 'bold' }] }] };
    expect(detect([h, body()])).toEqual([]);
  });

  it('indexes against the document, so a table between paragraphs does not shift the answer', () => {
    const table: JSONContent = { type: 'opaqueBlock', attrs: { kind: 'unknownField', label: 'table', fragmentId: 'x' } };
    const got = detect([table, para('Specific Aims', { bold: true }), body()]);
    expect(got.map(c => c.index)).toEqual([1]);
  });

  it('KNOWN_SECTIONS covers the NIH and manuscript names the brief lists', () => {
    const names = [
      'Project Summary', 'Abstract', 'Project Narrative', 'Specific Aims', 'Research Strategy', 'Significance', 'Innovation', 'Approach',
      'Preliminary Studies', 'Preliminary Data', 'Rigor', 'Timeline', 'Vertebrate Animals', 'Human Subjects', 'Select Agent Research',
      'Resource Sharing Plan', 'Data Management and Sharing Plan', 'Authentication of Key Biological and/or Chemical Resources',
      'Multiple PD/PI Leadership Plan', 'Consortium/Contractual Arrangements', 'Letters of Support', 'Facilities', 'Equipment', 'Biosketch',
      'Budget Justification', 'Introduction to Resubmission', 'Introduction to Revision', "Candidate's Background", 'Career Goals and Objectives',
      'Career Development/Training Activities', 'Training in Responsible Conduct of Research', 'Sponsor and Co-Sponsor', 'Introduction',
      'Methods', 'Materials and Methods', 'Results', 'Discussion', 'Conclusion', 'References', 'Acknowledgements', 'Author Contributions',
      'Competing Interests', 'Figure Legends', 'Supplementary',
    ];
    expect(KNOWN_SECTIONS.length).toBeGreaterThan(0);
    for (const n of names) expect(detect([para(n, { bold: true }), body()]), n).toHaveLength(1);
  });
});

describe('bold and size that come from styles, not direct marks', () => {
  const format = (() => {
    const f = createFormat('nih');
    f.styles.strong = { id: 'strong', name: 'Strong', type: 'character', bold: true };
    f.styles.plainchar = { id: 'plainchar', name: 'Plain', type: 'character' };
    f.styles.boldpara = { id: 'boldpara', name: 'Bold paragraph', type: 'paragraph', basedOn: 'normal', bold: true, fontSizePt: 14 };
    return f;
  })();
  const withMarks = (text: string, marks: JSONContent['marks'], styleId: string | null = null): JSONContent => ({
    type: 'paragraph', attrs: { styleId }, content: [{ type: 'text', text, ...(marks ? { marks } : {}) }],
  });
  const body = (): JSONContent => withMarks('Plain body text that goes on for a while and ends properly.', undefined);

  it('sees bold from a character style (Word\'s "Strong"), which one real grant uses for every section title', () => {
    const blocks = [withMarks('2.4. Schedule and milestones', [{ type: 'characterStyle', attrs: { styleId: 'strong' } }]), body()];
    expect(paragraphDrafts(blocks)[0].allBold).toBe(false); // without the format it cannot know
    expect(paragraphDrafts(blocks, { format })[0].allBold).toBe(true);
    expect(detectHeadings(paragraphDrafts(blocks, { format }), { hasRealHeadings: false })).toHaveLength(1);
  });

  it('does not take a character style that is not bold for bold', () => {
    const blocks = [withMarks('2.4. Schedule and milestones', [{ type: 'characterStyle', attrs: { styleId: 'plainchar' } }]), body()];
    expect(paragraphDrafts(blocks, { format })[0].allBold).toBe(false);
  });

  it('sees bold and size from the paragraph style', () => {
    const d = paragraphDrafts([withMarks('Some Title Here', undefined, 'boldpara'), body()], { format });
    expect(d[0]).toMatchObject({ allBold: true, minFontSizePt: 14 });
    expect(d[1].allBold).toBe(false);
  });
});

describe('an explicit "not bold" in the original XML beats a bold style', () => {
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const format = (() => {
    const f = createFormat('nih');
    f.styles.strong = { id: 'strong', name: 'Strong', type: 'character', bold: true };
    return f;
  })();
  const styleIdByWordId = new Map([['Strong', 'strong']]);
  const xml = (rPr: string) => `<w:p xmlns:w="${W}"><w:r><w:rPr>${rPr}</w:rPr><w:t>Short line here</w:t></w:r></w:p>`;
  const stamped = (blockId: string) =>
    stampProvenance(specNormalizeNode({ type: 'paragraph', attrs: { styleId: null }, content: [{ type: 'text', text: 'Short line here', marks: [{ type: 'characterStyle', attrs: { styleId: 'strong' } }] }] }), blockId);
  const store = (rPr: string) => ({ b1: { xml: xml(rPr), relIds: [], nsDecls: {} } });

  it('reads Strong + <w:b w:val="0"/> as NOT bold, and plain Strong as bold', () => {
    const off = paragraphDrafts([stamped('b1')], { format, styleIdByWordId, blocks: store('<w:rStyle w:val="Strong"/><w:b w:val="0"/>') });
    const on = paragraphDrafts([stamped('b1')], { format, styleIdByWordId, blocks: store('<w:rStyle w:val="Strong"/>') });
    expect(off[0].allBold).toBe(false);
    expect(on[0].allBold).toBe(true);
    // the node alone cannot tell the two apart: this is why the original XML is consulted
    expect(paragraphDrafts([stamped('b1')], { format })[0].allBold).toBe(true);
  });

  it('reads an explicit size from the original XML', () => {
    const d = paragraphDrafts([stamped('b1')], { format, styleIdByWordId, blocks: store('<w:rStyle w:val="Strong"/><w:sz w:val="40"/>') });
    expect(d[0].minFontSizePt).toBe(20);
  });

  it('ignores the original XML once the paragraph has been edited, because it no longer describes the node', () => {
    const edited = { ...stamped('b1'), content: [{ type: 'text', text: 'Edited line', marks: [{ type: 'characterStyle', attrs: { styleId: 'strong' } }] }] };
    const d = paragraphDrafts([edited], { format, styleIdByWordId, blocks: store('<w:rStyle w:val="Strong"/><w:b w:val="0"/>') });
    expect(d[0].allBold).toBe(true); // node-derived
  });
});

describe('inferHeadings measures the body size from the text, not from docDefaults', () => {
  it('a document with 10 pt text under an 11 pt default does not treat every short line as larger', () => {
    const f = createFormat('nih');
    f.defaults.fontSizePt = 11;
    const sized = (text: string): JSONContent => ({
      type: 'paragraph', attrs: { styleId: null },
      content: [{ type: 'text', text, marks: [{ type: 'fontSize', attrs: { sizePt: 10 } }] }],
    });
    const long = 'This is a long body paragraph with plenty of words in it so that it is clearly body text and nothing else at all.';
    const doc = { type: 'doc', content: [sized('Some short line'), sized(long), sized('Another short line'), sized(long)] } as JSONContent;
    const report = createReport();
    const got = inferHeadings(doc, { styles: { format: f }, report } as unknown as ReadContext);
    expect(got).toEqual([]);
    // an 11 pt line IS larger than the 10 pt body
    const bigLine: JSONContent = { type: 'paragraph', attrs: { styleId: null }, content: [{ type: 'text', text: 'Some short line', marks: [{ type: 'fontSize', attrs: { sizePt: 14 } }] }] };
    const got2 = inferHeadings({ type: 'doc', content: [bigLine, sized(long)] } as JSONContent, { styles: { format: f }, report: createReport() } as unknown as ReadContext);
    expect(got2).toHaveLength(1);
  });
});

describe('applyHeadings', async () => {
  const r = await readBody('unstyled-sections.docx');
  const found = detect(r.blocks);

  it('converts only the accepted paragraphs, to headings that keep their provenance and inline content', () => {
    const accepted = found.filter(c => c.text === 'Specific Aims' || c.text === 'Vertebrate Animals');
    expect(accepted).toHaveLength(2);
    const out = applyHeadings(r.doc, accepted);
    const content = out.content!;
    expect(content).toHaveLength(r.blocks.length);
    r.blocks.forEach((before, i) => {
      const hit = accepted.find(a => a.index === i);
      if (!hit) {
        // Not accepted: the very same node, byte for byte, provenance included.
        expect(content[i]).toBe(before);
        return;
      }
      expect(content[i].type).toBe('heading');
      expect(content[i].attrs).toMatchObject({ level: hit.level, styleId: null });
      expect(content[i].attrs!.ooxml).toEqual(before.attrs!.ooxml);
      expect(content[i].content).toEqual(before.content);
    });
  });

  it('leaves every paragraph it did not convert reading as untouched', () => {
    const out = applyHeadings(r.doc, found.slice(0, 1));
    const untouched = out.content!.filter((b, i) => i !== found[0].index);
    expect(untouched.every(isBlockUntouched)).toBe(true);
  });

  it('does not let a converted paragraph read as untouched: its content (type and level) changed, so the exporter must regenerate it', () => {
    const out = applyHeadings(r.doc, found);
    for (const c of found) {
      const before = r.blocks[c.index];
      const after = out.content![c.index];
      expect(isBlockUntouched(before)).toBe(true);
      expect(isBlockUntouched(after)).toBe(false);
      // ...while the link back to the original <w:p> (blockId) survives so its pPr extras stay recoverable
      expect((after.attrs!.ooxml as { blockId: string }).blockId).toBe((before.attrs!.ooxml as { blockId: string }).blockId);
    }
  });

  it('accepting nothing returns the same content, and the input is never mutated', () => {
    const snapshot = JSON.stringify(r.doc);
    const out = applyHeadings(r.doc, []);
    expect(out.content).toEqual(r.doc.content);
    applyHeadings(r.doc, found);
    expect(JSON.stringify(r.doc)).toBe(snapshot);
  });

  it('keeps the paragraph formatting it had (alignment, spacing) on the heading', () => {
    const p: JSONContent = { type: 'paragraph', attrs: { styleId: 'normal', textAlign: 'center', spaceBefore: 12, ooxml: { blockId: 'b1', sourceHash: 'h' } }, content: [{ type: 'text', text: 'Methods' }] };
    const out = applyHeadings({ type: 'doc', content: [p] }, [{ index: 0, level: 2, text: 'Methods', evidence: ['x'], confidence: 'name' }]);
    expect(out.content![0].attrs).toMatchObject({ level: 2, styleId: null, textAlign: 'center', spaceBefore: 12, ooxml: { blockId: 'b1', sourceHash: 'h' } });
  });

  it('ignores a candidate whose index is not a paragraph, rather than rewriting some other block', () => {
    const table: JSONContent = { type: 'opaqueBlock', attrs: { kind: 'unknownField', label: 'table', fragmentId: 'x' } };
    const out = applyHeadings({ type: 'doc', content: [table] }, [{ index: 0, level: 1, text: 't', evidence: ['x'], confidence: 'format' }]);
    expect(out.content![0]).toBe(table);
    const missing = applyHeadings({ type: 'doc', content: [] }, [{ index: 3, level: 1, text: 't', evidence: ['x'], confidence: 'format' }]);
    expect(missing.content).toEqual([]);
  });

  it('produces a document the editor schema accepts', () => {
    const out = applyHeadings(r.doc, found);
    expect(() => getSpecSchema().nodeFromJSON(out).check()).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('evidence describes only the checks that fired', () => {
  const para = (text: string, bold = false): JSONContent => ({
    type: 'paragraph', attrs: { styleId: null }, content: [{ type: 'text', text, ...(bold ? { marks: [{ type: 'bold' }] } : {}) }],
  });
  const body = () => para('Plain body text that goes on for a while and ends properly.');

  it('a name match ending in a colon does not claim "no terminal punctuation", and does not claim a follower was checked', () => {
    const ev = detect([para('Specific Aims:', true), body()])[0].evidence.join(' | ');
    expect(ev).not.toMatch(/no terminal punctuation/);
    expect(ev).toMatch(/no terminal period, question or exclamation mark/);
    expect(ev).not.toMatch(/followed by/);
    expect(ev).not.toMatch(/emphasis/);
  });

  it('a plain name match says it is not bold, and a bold one says it is', () => {
    expect(detect([para('Introduction'), body()])[0].evidence.join(' | ')).toContain('not bold');
    expect(detect([para('Introduction', true), body()])[0].evidence.join(' | ')).toContain('entire paragraph is bold');
  });

  it('a format match claims only what it checked', () => {
    const ev = detect([para('A short bold title', true), body()])[0].evidence.join(' | ');
    expect(ev).toContain('entire paragraph is bold');
    expect(ev).toContain('followed by a body paragraph that is not bold or larger');
    expect(ev).not.toMatch(/larger font|enumerator|nearest member|sentences/);
  });

  it('a sibling is described as bold or as larger, matching how it qualified', () => {
    const run = [para('2.1 One', true), body(), para('2.2 Two', true), body()];
    const long = 'A title that is long enough to fail the eight word format limit';
    const bold = detect([...run, para(`2.3 ${long}`, true), body()]).find(c => c.confidence === 'sibling')!;
    expect(bold.evidence.join(' | ')).toContain('bold, like the nearest member of the run (2.2, bold)');
    const big: JSONContent = { type: 'paragraph', attrs: { styleId: null }, content: [{ type: 'text', text: `2.3 ${long}`, marks: [{ type: 'fontSize', attrs: { sizePt: 16 } }] }] };
    const bigHead = (t: string): JSONContent => ({ type: 'paragraph', attrs: { styleId: null }, content: [{ type: 'text', text: t, marks: [{ type: 'fontSize', attrs: { sizePt: 16 } }] }] });
    const bigRun = [bigHead('2.1 One'), body(), bigHead('2.2 Two'), body()];
    const larger = detectHeadings(paragraphDrafts([...bigRun, big, body()]), { hasRealHeadings: false, bodyFontSizePt: 11 }).find(c => c.confidence === 'sibling')!;
    expect(larger.evidence.join(' | ')).toContain('larger than the body text, like the nearest member of the run (2.2, larger than the body text)');
  });
});

describe('aim titles (R1)', () => {
  const para = (text: string, bold = false): JSONContent => ({
    type: 'paragraph', attrs: { styleId: null }, content: [{ type: 'text', text, ...(bold ? { marks: [{ type: 'bold' }] } : {}) }],
  });
  const body = () => para('Plain body text that goes on for a while and ends properly.');
  const one = (t: string, bold = false) => detect([para(t, bold), body()]);

  it('detects Aim/AIM with an arabic or roman numeral and a separator, bold or not, with or without a final period', () => {
    for (const t of ['AIM 1: Characterize the antibody response', 'AIM 2. Map the T cell response to the viral peptides.', 'Aim III) Test the model', 'Aim 4', 'A. Aim 1: Define it']) {
      const got = one(t);
      expect(got, t).toHaveLength(1);
      expect(got[0], t).toMatchObject({ level: 2, confidence: 'aim' });
    }
  });

  it('allows up to 30 words, not 31, and still refuses a question or an exclamation', () => {
    const words = (n: number) => 'Aim 1: ' + Array.from({ length: n - 2 }, (_, i) => `w${i}`).join(' ');
    expect(one(words(30))).toHaveLength(1);
    expect(one(words(31))).toHaveLength(0);
    expect(one('Aim 1: what happens next?')).toHaveLength(0);
  });

  it('does not promote ordinary sentences that start with an aim number', () => {
    for (const t of [
      'Aim 2 will determine the structure of the F protein.',
      'Aim 2 of this proposal is to test whether F binds H.',
      'Aim 1 builds on preliminary data from Aim 2 and Aim 3.',
      'Aim 1 tests the model',
      'Aim 3 addresses the gap',
      'Aim 1: will determine the structure',
      'Aim 2 differs from the first in scope',
      'Aim 1 here is a short summary of the work',
      'Aim 3 deals with the remaining gap',
      'Aim 1 This aim tests the model',
      'Aim 2 We will determine the structure',
      'Aim 2 In this aim we test F',
      'Aim 1 Our data suggest a mechanism',
    ]) expect(one(t), t).toHaveLength(0);
  });

  it('is not proposed for a table-of-contents line: dot leaders, or followed by more short lines instead of body text', () => {
    const toc = (...lines: string[]) => detect([...lines.map(t => para(t)), body()]);
    expect(toc('Aim 1 ........ 4', 'Aim 2 ........ 9')).toHaveLength(0);
    expect(toc('Aim 2: Characterize the response ..... 9')).toHaveLength(0);
    expect(detect([para('Aim 1: Characterize the response 4'), para('Aim 2: Map the T cell response 9')])).toHaveLength(0);
    // and a title with nothing after it, or with a bold title after it
    expect(detect([para('Aim 1: Characterize the response')])).toHaveLength(0);
    expect(detect([para('Aim 1: Characterize the response'), para('Rationale', true), body()]).filter(c => c.confidence === 'aim')).toHaveLength(0);
    // control
    expect(one('Aim 1: Characterize the response')).toHaveLength(1);
    expect(one('Aim 1: Characterize the response')[0].evidence.join(' | ')).toMatch(/followed by a body paragraph of \d+ words/);
  });

  it('keeps "In vivo ..." and "This approach ..." titles after a separator, and still refuses the prose forms without one', () => {
    for (const t of ['AIM 2: In vivo validation of the model', 'AIM 2: This approach tests the model', 'Aim 1: In vitro characterization', 'Aim 3. Our data-driven model', 'Aim 2: We define the lineage', 'Aim 1: Here we test F']) {
      const got = one(t);
      expect(got, t).toHaveLength(1);
      expect(got[0].confidence, t).toBe('aim');
    }
    for (const t of ['Aim 1 This aim tests the model', 'Aim 2 We will determine the structure', 'Aim 2 In this aim we test F', 'Aim 1 Our data suggest a mechanism', 'Aim 1 Here we test F']) {
      expect(one(t), t).toHaveLength(0);
    }
    // words that mean a sentence whatever follows the number
    expect(one('Aim 1: will determine the structure')).toHaveLength(0);
  });

  it('accepts the capital-initial form without a separator, and "Aim 1: To ..." with one', () => {
    expect(one('Aim 1 Characterize the response')[0]).toMatchObject({ confidence: 'aim' });
    expect(one('Aim 2 Map the T cell response')[0]).toMatchObject({ confidence: 'aim' });
    expect(one('Aim 1: To define the breadth of the response')[0]).toMatchObject({ confidence: 'aim' });
    expect(one('Aim 1 To define the breadth')).toHaveLength(0);
  });

  it('does not take "Aim in ...", "Aimed ..." or a sentence that merely mentions an aim for an aim title', () => {
    expect(one('Aim in the right direction')).toHaveLength(0);
    expect(one('Aims 1 and 2 are independent')).toHaveLength(0);
    expect(one('The first Aim 1 is to test')).toHaveLength(0);
  });

  it('is level 2 below a preceding level-1 heading, and level 2 when none precedes', () => {
    const got = detect([para('Specific Aims', true), body(), para('Aim 1: First'), body()]);
    expect(got.map(c => [c.text, c.level, c.confidence])).toEqual([['Specific Aims', 1, 'name'], ['Aim 1: First', 2, 'aim']]);
    expect(got[1].evidence.join(' | ')).toContain('Specific Aims');
    expect(one('Aim 1: First')[0].level).toBe(2);
  });

  it('says so when an aim line holds more than one sentence, because accepting it makes all of it the heading', () => {
    const two = one('AIM 1: Characterize the response. Objective: To define the breadth of it.');
    expect(two[0].evidence.join(' | ')).toMatch(/2 sentences/);
    expect(one('AIM 2. Map the T cell response.')[0].evidence.join(' | ')).not.toMatch(/sentences/);
  });

  it('still refuses a multi-line paragraph, or one holding an opaque atom', () => {
    const br: JSONContent = { type: 'paragraph', attrs: { styleId: null }, content: [{ type: 'text', text: 'Aim 1: first' }, { type: 'hardBreak' }, { type: 'text', text: 'more' }] };
    const atom: JSONContent = { type: 'paragraph', attrs: { styleId: null }, content: [{ type: 'text', text: 'Aim 1: first' }, { type: 'opaqueInline', attrs: { kind: 'bookmark', label: 'bookmark', fragmentId: 'x' } }] };
    expect(detect([br, body()])).toHaveLength(0);
    expect(detect([atom, body()])).toHaveLength(0);
  });
});

describe('numbered-sibling completion (R2)', () => {
  const para = (text: string, bold = false): JSONContent => ({
    type: 'paragraph', attrs: { styleId: null }, content: [{ type: 'text', text, ...(bold ? { marks: [{ type: 'bold' }] } : {}) }],
  });
  const body = () => para('Plain body text that goes on for a while and ends properly.');
  const section = (t: string, bold = true) => [para(t, bold), body()];
  // Over the 8-word format limit, so the format path cannot find it: only numbered-sibling completion can.
  const LONG = 'A bold title that is long enough to fail the eight word format limit';
  const long = (n: string) => section(`${n} ${LONG}`);

  it('fills the hole in 2.1, 2.2, [2.3], 2.4 with a bold line that fails the format test (too long, a comma), at the run\'s level', () => {
    const blocks = [...section('2.1 First part'), ...section('2.2 Second part'), ...section('2.3 A much longer title, with a comma, that fails the eight word format limit'), ...section('2.4 Fourth part')];
    const got = detect(blocks);
    expect(got.map(c => [c.text.slice(0, 4), c.confidence, c.level])).toEqual([['2.1 ', 'format', 2], ['2.2 ', 'format', 2], ['2.3 ', 'sibling', 2], ['2.4 ', 'format', 2]]);
    const sib = got[2];
    expect(sib.evidence.join(' | ')).toMatch(/fills a gap in the numbered run 2\.1, 2\.2, 2\.4/);
  });

  it('lets a bold two-line paragraph (title, then sub-title) complete a run, but never one with a break and body text', () => {
    const br = (marks: JSONContent['marks']): JSONContent => ({ type: 'paragraph', attrs: { styleId: null }, content: [{ type: 'text', text: '2.3 Detailed plan', marks }, { type: 'hardBreak' }, { type: 'text', text: 'Project 1 Structure', marks }] });
    const run = [...section('2.1 One'), ...section('2.2 Two'), ...section('2.4 Four')];
    const gap = (p: JSONContent) => detect([...run.slice(0, 4), p, body(), ...run.slice(4)]).find(c => c.text.startsWith('2.3'));
    expect(gap(br([{ type: 'bold' }]))).toMatchObject({ confidence: 'sibling' });
    expect(gap(br([{ type: 'bold' }]))!.evidence.join(' ')).toMatch(/two bold lines/);
    expect(gap(br(undefined))).toBeUndefined();
    // and on its own a multi-line paragraph is still not a heading
    expect(detect([br([{ type: 'bold' }]), body()])).toHaveLength(0);
  });

  it('extends a run by one at either end, and chains', () => {
    const blocks = [...section('2.2 Second part'), ...section('2.3 Third part'), ...section('2.4 A longer bold title that fails the eight word limit'), ...section('2.5 Another longer bold title that fails the eight word limit'), ...section('2.1 A longer bold title that is first but sits last in the document')];
    // 2.1 is out of document order (after 2.5), so it is refused; 2.4 then 2.5 chain on
    expect(detect(blocks).map(c => [c.text.slice(0, 3), c.confidence])).toEqual([['2.2', 'format'], ['2.3', 'format'], ['2.4', 'sibling'], ['2.5', 'sibling']]);
  });

  it('needs two members already found, and a number that is next to the run', () => {
    expect(detect([...section('2.1 Only one', true), ...section('2.2 plain follower', false)]).map(c => c.text.slice(0, 3))).toEqual(['2.1']);
    const far = [...section('2.1 One'), ...section('2.2 Two'), ...long('2.7')];
    expect(detect(far).map(c => c.text.slice(0, 3))).toEqual(['2.1', '2.2']);
  });

  it('keeps the other rules: one short line (30 words), no terminal period, a different prefix does not join', () => {
    const run = [...section('2.1 One'), ...section('2.2 Two')];
    const tooLong = '2.3 ' + Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ');
    const joins = (blocks: JSONContent[], prefix: string) => detect(blocks).find(c => c.text.startsWith(prefix))?.confidence === 'sibling';
    expect(joins([...run, ...section(tooLong), ...section('2.4 Four')], '2.3')).toBe(false);
    expect(joins([...run, ...section(`2.3 ${LONG}.`)], '2.3')).toBe(false);
    expect(joins([...run, ...long('3.3')], '3.3')).toBe(false);
    expect(joins([...run, ...long('2.2.3')], '2.2.3')).toBe(false);
    // control: the same shape DOES join when it obeys the rules
    expect(joins([...run, ...long('2.3')], '2.3')).toBe(true);
  });

  it('does not chain on single-part numbers, because numbered lists and reference lists look like that', () => {
    const blocks = [...section('1. First'), ...section('3. Third'), ...long('2.')];
    expect(detect(blocks).map(c => c.text.slice(0, 2))).toEqual(['1.', '3.']);
    expect(detect(blocks).some(c => c.confidence === 'sibling')).toBe(false);
  });

  describe('what it must not promote (numbered body text, distant and list-like lines)', () => {
    const run = [...section('2.1 One'), ...section('2.2 Two'), ...section('2.4 Four')];
    const has = (blocks: JSONContent[], prefix: string) => detect(blocks).find(c => c.text.startsWith(prefix))?.confidence === 'sibling';

    it('a number-led quantity such as "2.3 mM Tris buffer" is not a heading, plain or bold', () => {
      const tris = '2.3 mM Tris buffer used throughout all of the experiments described in this section';
      expect(has([...run.slice(0, 4), ...section(tris, false), ...run.slice(4)], '2.3')).toBe(false);
      expect(has([...run.slice(0, 4), ...section(tris, true), ...run.slice(4)], '2.3')).toBe(false); // bold, so only the capital-letter rule stops it
      expect(has([...run.slice(0, 4), ...section(tris.replace('2.3 mM', '2.3 Mm'), true), ...run.slice(4)], '2.3')).toBe(true);
    });

    it('a line far from the run is not a sibling however well it is numbered, but the same line close by is', () => {
      const filler = Array.from({ length: 40 }, body);
      const tight = [...section('2.1 One'), ...section('2.2 Two')];
      expect(has([...tight, ...filler, ...long('2.3')], '2.3')).toBe(false);
      expect(has([...tight, ...long('2.3')], '2.3')).toBe(true);
      // the bound is the larger of 12 paragraphs and twice the run's widest spacing
      const sparse = [para('2.1 One', true), ...Array.from({ length: 29 }, body), para('2.2 Two', true), body()];
      expect(has([...sparse, ...Array.from({ length: 40 }, body), para(`2.3 ${LONG}`, true), body()], '2.3')).toBe(true);
      expect(has([...sparse, ...Array.from({ length: 100 }, body), para(`2.3 ${LONG}`, true), body()], '2.3')).toBe(false);
    });

    it('a numbered list under real headings does not chain in, comma and all', () => {
      const blocks = [para('2.1 One', true), body(), para('2.2 Two', true), body(), para('2.3 Collect samples at day 0, 7, and 14', false), para('2.4 Process the samples', false), para('2.5 Store them', false), body()];
      expect(detect(blocks).map(c => c.text.slice(0, 3))).toEqual(['2.1', '2.2']);
    });

    it('a plain table-of-contents line does not join a run of real headings', () => {
      const headings = [...section('2.2 Beta'), ...section('2.3 Gamma'), ...section('2.5 Epsilon')];
      const toc = [para(`2.1 ${LONG}`, false), body()];
      expect(detect([...toc, ...headings]).some(c => c.index === 0)).toBe(false);
      // control: the same line set as a bold title does join
      expect(detect([...long('2.1'), ...headings]).find(c => c.index === 0)?.confidence).toBe('sibling');
    });

    it('a bold sibling candidate still needs body text after it, not another title', () => {
      const blocks = [...run.slice(0, 4), para(`2.3 ${LONG}`, true), para('Another bold title right after it', true), body(), ...run.slice(4)];
      expect(has(blocks, '2.3')).toBe(false);
      expect(has([...run.slice(0, 4), ...long('2.3'), ...run.slice(4)], '2.3')).toBe(true);
    });

    it('its evidence reports the distance and the conditions it met', () => {
      const got = detect([...run.slice(0, 4), ...long('2.3'), ...run.slice(4)]).find(c => c.text.startsWith('2.3'))!;
      const ev = got.evidence.join(' | ');
      expect(ev).toMatch(/\d+ paragraphs? from that member \(at most \d+ allowed\)/);
      expect(ev).toContain('bold, like the nearest member of the run (2.2, bold)');
      expect(ev).toContain('starts with a capital letter');
      expect(ev).toContain('followed by a body paragraph that is not bold or larger');
      expect(ev).not.toContain('same emphasis as the run');
    });

    it('a plain numbered list under PLAIN name-matched headings does not chain in either', () => {
      const blocks = [para('2.1 Introduction', false), body(), para('2.2 Methods', false), body(), para('2.3 Collect samples at day 0, 7, and 14', false), para('2.4 Process the samples', false), body()];
      expect(detect(blocks).map(c => [c.text.slice(0, 3), c.confidence])).toEqual([['2.1', 'name'], ['2.2', 'name']]);
    });

    it('a mixed run (bold, then plain) does not admit a plain line, and a plain nearest member does not vouch for a bold one', () => {
      const mixed = [para('2.1 One', true), body(), para('2.2 Methods', false), body()];
      expect(has([...mixed, para('2.3 Order the reagents from the supplier', false), body()], '2.3')).toBe(false);
      // bold candidate, but its nearest member (2.2) is plain
      expect(has([...mixed, ...long('2.3')], '2.3')).toBe(false);
      // control: with a bold nearest member the same bold line joins
      expect(has([para('2.1 Methods', false), body(), para('2.2 One', true), body(), ...long('2.3')], '2.3')).toBe(true);
    });

    it('the reach binds a gap fill too: a line in the middle of a 300-paragraph gap is not a sibling', () => {
      const filler = (n: number) => Array.from({ length: n }, body);
      const head = [...section('2.1 One'), ...section('2.2 Two')];
      const tail = [...section('2.4 Four'), ...section('2.5 Five')];
      expect(has([...head, ...filler(150), ...long('2.3'), ...filler(150), ...tail], '2.3')).toBe(false);
      // control: the same gap fill close to its neighbour is a sibling
      expect(has([...head, ...filler(4), ...long('2.3'), ...filler(4), ...tail], '2.3')).toBe(true);
    });

    it('lengthening the section before a gap fill does not drop it: it is admitted on the gap it completes, and says so', () => {
      const filler = (n: number) => Array.from({ length: n }, body);
      const doc = (before: number, after = 40) => [...section('2.1 One'), para('2.2 Two', true), ...filler(before), ...long('2.3'), ...filler(after), ...section('2.4 Four'), ...section('2.5 Five')];
      for (const before of [4, 12, 16, 19, 40, 80]) {
        const got = detect(doc(before)).find(c => c.text.startsWith('2.3'));
        expect(got?.confidence, `${before} paragraphs after 2.2`).toBe('sibling');
      }
      // near enough: reported as a distance; far: reported as the gap it completes
      expect(detect(doc(4)).find(c => c.text.startsWith('2.3'))!.evidence.join(' | ')).toMatch(/\d+ paragraphs? from that member \(at most \d+ allowed\)/);
      const far = detect(doc(80, 80)).find(c => c.text.startsWith('2.3'))!.evidence.join(' | ');
      expect(far).toMatch(/lies in a gap of \d+ paragraphs between 2\.2 and 2\.4 \(at most 200 allowed: 100 per number step, and 2\.2 to 2\.4 is 2 steps\)/);
      expect(far).not.toMatch(/from that member \(at most/);
      // but a wide enough gap is still refused (the 300-paragraph test above), and an extension never gets this route
      expect(detect(doc(150, 150)).some(c => c.text.startsWith('2.3'))).toBe(false);
    });

    it('a missing member does not inflate the reach of an extension', () => {
      const filler = (n: number) => Array.from({ length: n }, body);
      // 2.1/2.2 are close; 2.4 is 300 paragraphs on. The hole spans 300, but that is not evidence of how far apart sections are.
      const base = [...section('2.1 One'), ...section('2.2 Two'), ...filler(300), ...section('2.4 Four')];
      expect(has([...base, ...filler(250), ...long('2.5')], '2.5')).toBe(false);
      expect(has([...base, ...filler(4), ...long('2.5')], '2.5')).toBe(true);
    });
  });

  it('must sit between its neighbours in the document', () => {
    const blocks = [...section('2.1 One'), ...section('2.3 Three'), ...long('2.2')];
    expect(detect(blocks).some(c => c.text.startsWith('2.2'))).toBe(false);
  });
});

describe('format-path guards: look-alikes of a bold section title', () => {
  const para = (text: string, bold = true): JSONContent => ({
    type: 'paragraph', attrs: { styleId: null }, content: [{ type: 'text', text, ...(bold ? { marks: [{ type: 'bold' }] } : {}) }],
  });
  const body = () => para('Plain body text that goes on for a while and ends properly.', false);
  const found = (t: string) => detect([para(t), body()]);

  it('control: a plain short bold title is still detected', () => {
    expect(found('Mitochondrial Stress Signalling')).toHaveLength(1);
  });

  it.each([
    ['an author list (comma)', 'Dawid Zyla, Jane Smith, John Doe'],
    ['a comma-spliced lead-in', 'In mice, the pathway is conserved'],
  ])('rejects %s', (_n, t) => expect(found(t)).toHaveLength(0));

  it.each([
    ['a long-form date', 'October 7 2026'],
    ['a long-form date with a comma', 'October 7, 2026'],
    ['a month and year', 'March 2026'],
    ['a bare month', 'October'],
    ['a numeric date', '2026-10-07'],
    ['a slashed date', '10/07/2026'],
  ])('rejects %s', (_n, t) => expect(found(t)).toHaveLength(0));

  it('does not mistake a dotted section number for a date, or "March" inside a longer word', () => {
    expect(found('1.2.3 Current state of research')).toHaveLength(1);
    expect(found('Marching Orders for Muscle')).toHaveLength(1);
  });

  it.each(['Page 3 of 12', 'Page 3', '3 of 12'])('rejects the running head %s', t => expect(found(t)).toHaveLength(0));

  it.each([
    'Key finding: knockdown halves the response',
    'Importantly the pathway is conserved',
    'Notably',
    'Interestingly this holds',
    'However this fails',
    'Moreover it scales',
    'Furthermore we show',
    'In summary the data agree',
    'Of note this is rare',
    'Conversely it is lost',
    'Therefore we conclude',
  ])('rejects the bold lead-in "%s"', t => expect(found(t)).toHaveLength(0));

  it('does not reject a title that merely starts like a marker word', () => {
    expect(found('Importance of Rigor Here')).toHaveLength(1);
    expect(found('Keyboard Findings Overview')).toHaveLength(1);
  });

  it.each(['CONFIDENTIAL', 'DRAFT', 'DRAFT - do not distribute', 'PRELIMINARY', 'DO NOT DISTRIBUTE', 'FOR REVIEW ONLY', 'Draft: for review only'])(
    'rejects the status stamp "%s"',
    t => expect(found(t)).toHaveLength(0),
  );

  it('allows a title that starts with a status word but continues as a title', () => {
    expect(found('Draft Genome Assembly')).toHaveLength(1);
    expect(found('Preliminary Results Overview')).toHaveLength(1);
  });

  it.each(['Panel A', 'Panel 3', 'Extended Data Fig. 3', 'Extended Data Table 1', 'Supplementary Figure', 'Supplementary Table', 'Note', 'Notes', 'Note:'])(
    'rejects the label "%s"',
    t => expect(found(t)).toHaveLength(0),
  );

  it('pins the numeric-date guard on its own: letters elsewhere in the line, so no other check can reject it first', () => {
    expect(found('Updated 10/07/2026')).toHaveLength(0);
    expect(found('Revised 2026-10-07')).toHaveLength(0);
    expect(found('Updated Records Overview')).toHaveLength(1);
  });

  it('pins the status-phrase guard on its own: the phrase sits mid-string, where the leading-word check cannot see it', () => {
    expect(found('Report - Do not distribute copy')).toHaveLength(0);
    expect(found('Grant Text For Review Only')).toHaveLength(0);
  });

  it.each(['Draft: v2', 'Confidential (internal)', 'Preliminary [v3]', 'DRAFT | Page'])('rejects a status word followed by the separator in "%s"', t =>
    expect(found(t)).toHaveLength(0),
  );

  it.each(['Supplementary Data', 'Supplementary Table S1', 'Key Findings', 'Key Findings Summary'])('rejects the label or lead-in "%s"', t =>
    expect(found(t)).toHaveLength(0),
  );

  it('applies to format matches only: a known section name, an aim title and a numbered sibling are never refused by them', () => {
    expect(found('Preliminary Data')[0]).toMatchObject({ confidence: 'name' });
    expect(found('Notes')).toHaveLength(0);
    expect(detect([para('Aim 1: Test X, Y, and Z in October'), body()])[0]).toMatchObject({ confidence: 'aim' });
    const run = [para('2.1 One'), body(), para('2.2 Two'), body(), para('2.3 Draft, rev 2'), body(), para('2.4 Four'), body()];
    expect(detect(run).find(c => c.text.startsWith('2.3'))).toMatchObject({ confidence: 'sibling' });
  });
});

describe('level reset after the references', () => {
  const para = (text: string, bold = true): JSONContent => ({
    type: 'paragraph', attrs: { styleId: null }, content: [{ type: 'text', text, ...(bold ? { marks: [{ type: 'bold' }] } : {}) }],
  });
  const body = () => para('Plain body text that goes on for a while and ends properly.', false);

  it('does not let trailing matter inherit a level-2 slot from the body', () => {
    const got = detect([para('Specific Aims'), body(), para('LITERATURE CITED:'), body(), para('Appendix Contents'), body()]);
    expect(got.map(c => [c.text, c.level])).toEqual([['Specific Aims', 1], ['LITERATURE CITED:', 1], ['Appendix Contents', 1]]);
    // control: without the references section the same line is level 2
    expect(detect([para('Specific Aims'), body(), para('Appendix Contents'), body()]).map(c => c.level)).toEqual([1, 2]);
  });
});

describe('detection skipped because the document has a styled heading', () => {
  const para = (text: string, bold = true): JSONContent => ({
    type: 'paragraph', attrs: { styleId: null }, content: [{ type: 'text', text, ...(bold ? { marks: [{ type: 'bold' }] } : {}) }],
  });
  const body = () => para('Plain body text that goes on for a while and ends properly.', false);
  const heading: JSONContent = { type: 'heading', attrs: { level: 1, styleId: 'heading1' }, content: [{ type: 'text', text: 'Title' }] };
  const unstyled = [para('Specific Aims'), body(), para('Mitochondrial Stress Signalling'), body(), para('Approach'), body()];

  it('with one styled heading plus many unstyled titles: proposes nothing and says why, once', () => {
    const report = createReport();
    const drafts = paragraphDrafts([heading, ...unstyled]);
    expect(detectHeadings(drafts, { hasRealHeadings: true, report })).toEqual([]);
    expect(report.counts.inferredHeading).toBeUndefined();
    const warns = report.warnings.filter(w => w.feature === 'inferredHeading');
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toMatch(/not inferred/);
    expect(warns[0].message).toMatch(/at least one Word heading style/);
    expect(warns[0].message).toContain('3 unstyled lines');
  });

  const readCtx = (report: ReturnType<typeof createReport>) =>
    ({ styles: { format: createFormat('nih'), styleIdByWordId: new Map() }, report, preservation: emptyPreservationStore() }) as unknown as ReadContext;

  it('a styled heading inside a table cell does not suppress inference for the section titles outside it', () => {
    const table: JSONContent = { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [heading] }] }] };
    const doc: JSONContent = { type: 'doc', content: [table, ...unstyled] };
    expect(hasHeadings(doc)).toBe(false);
    const report = createReport();
    const got = inferHeadings(doc, readCtx(report));
    expect(got.map(c => c.text)).toContain('Specific Aims');
    expect(report.counts.inferredHeading).toBe(got.length);
  });

  it('a styled heading inside a list item does not count either', () => {
    const list: JSONContent = { type: 'bulletList', content: [{ type: 'listItem', content: [heading] }] };
    expect(hasHeadings({ type: 'doc', content: [list, ...unstyled] })).toBe(false);
  });

  it('a styled heading at the top level, beside a table, still suppresses inference', () => {
    const table: JSONContent = { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [para('Cell text')] }] }] };
    const doc: JSONContent = { type: 'doc', content: [heading, table, ...unstyled] };
    expect(hasHeadings(doc)).toBe(true);
    const report = createReport();
    expect(inferHeadings(doc, readCtx(report))).toEqual([]);
    expect(report.warnings.filter(w => w.feature === 'inferredHeading')).toHaveLength(1);
  });

  it('stays quiet when nothing would have been proposed', () => {
    const report = createReport();
    detectHeadings(paragraphDrafts([heading, body(), body()]), { hasRealHeadings: true, report });
    expect(report.warnings).toEqual([]);
  });
});

describe('report bookkeeping is idempotent', () => {
  const para = (text: string): JSONContent => ({ type: 'paragraph', attrs: { styleId: null }, content: [{ type: 'text', text, marks: [{ type: 'bold' }] }] });
  const body: JSONContent = { type: 'paragraph', attrs: { styleId: null }, content: [{ type: 'text', text: 'Plain body text that goes on for a while and ends properly.' }] };
  const drafts = paragraphDrafts([para('Specific Aims'), body, para('Approach'), body]);

  it('running detection twice on one report counts once and warns once', () => {
    const report = createReport();
    detectHeadings(drafts, { hasRealHeadings: false, report });
    const once = JSON.stringify(report);
    detectHeadings(drafts, { hasRealHeadings: false, report });
    expect(JSON.stringify(report)).toBe(once);
    expect(report.counts.inferredHeading).toBe(2);
    expect(report.byCategory[2]).toBe(2);
    expect(report.warnings.filter(w => w.feature === 'inferredHeading')).toHaveLength(1);
  });

  it('a later run replaces the earlier result instead of adding to it, and leaves unrelated warnings alone', () => {
    const report = createReport();
    report.warnings.push({ feature: 'part', message: 'unrelated', category: 2 });
    detectHeadings(drafts, { hasRealHeadings: false, report });
    detectHeadings(drafts.slice(0, 2), { hasRealHeadings: false, report });
    expect(report.counts.inferredHeading).toBe(1);
    expect(report.byCategory[2]).toBe(1);
    expect(report.warnings.map(w => w.feature)).toEqual(['part', 'inferredHeading']);
    detectHeadings(drafts.slice(1, 2), { hasRealHeadings: false, report });
    expect(report.counts.inferredHeading).toBeUndefined();
    expect(report.warnings.map(w => w.feature)).toEqual(['part']);
  });
});

describe('a title followed by a list (lists are grouped before headings are inferred)', () => {
  const para = (text: string, bold = false): JSONContent => ({
    type: 'paragraph', attrs: { styleId: null }, content: [{ type: 'text', text, ...(bold ? { marks: [{ type: 'bold' }] } : {}) }],
  });
  const body = () => para('Plain body text that goes on for a while and ends properly.');
  const list = (items: string[], opts: { boldFirst?: boolean; ordered?: boolean } = {}): JSONContent => ({
    type: opts.ordered ? 'orderedList' : 'bulletList',
    content: items.map((t, i) => ({ type: 'listItem', content: [para(t, opts.boldFirst === true && i === 0)] })),
  });
  const BULLETS = ['Reduced relapse', 'Lower toxicity', 'A new target'];
  const evidence = (c: HeadingCandidate | undefined) => (c?.evidence ?? []).join(' | ');

  it('format path: a bold short title followed by a bullet list is detected, and the evidence says a list follows', () => {
    const blocks = [para('Expected Outcomes', true), list(BULLETS)];
    const found = detect(blocks);
    const c = byText(found, 'Expected Outcomes');
    expect(c).toMatchObject({ confidence: 'format', index: 0 });
    expect(evidence(c)).toContain('followed by a list whose first item is not bold or larger');
    expect(evidence(c)).not.toContain('body paragraph');
  });

  it('format path: a blank paragraph between the title and the list does not hide the list', () => {
    expect(byText(detect([para('Potential Pitfalls', true), para(''), list(BULLETS)]), 'Potential Pitfalls')).toMatchObject({ confidence: 'format' });
  });

  it('format path: a numbered list leads too', () => {
    expect(byText(detect([para('Milestones', true), list(BULLETS, { ordered: true })]), 'Milestones')).toBeDefined();
  });

  it('format path: a bold FIRST item means the list is not body text, so no title', () => {
    expect(detect([para('Expected Outcomes', true), list(BULLETS, { boldFirst: true })])).toEqual([]);
  });

  it('format path: a table or figure between the title and the list still ends the search', () => {
    expect(detect([para('Expected Outcomes', true), { type: 'table', content: [] } as JSONContent, list(BULLETS)])).toEqual([]);
  });

  it('aim path: "Aim 1: ..." followed by SHORT bullets is detected (the 8-word body minimum does not apply to a list)', () => {
    const c = byText(detect([para('Aim 1: Define the mechanism'), list(BULLETS)]), 'Aim 1: Define the mechanism');
    expect(c).toMatchObject({ confidence: 'aim', level: 2 });
    expect(evidence(c)).toMatch(/followed by a list whose first item \(2 words\) is not bold or larger/);
  });

  it('aim path: the same short line as a PARAGRAPH still fails the 8-word minimum', () => {
    expect(detect([para('Aim 1: Define the mechanism'), para('Too short here')])).toEqual([]);
  });

  it('aim path: a bold first bullet is refused', () => {
    expect(detect([para('Aim 1: Define the mechanism'), list(BULLETS, { boldFirst: true })])).toEqual([]);
  });

  it('sibling path: a numbered-run member that the format path cannot take is completed when a list follows it', () => {
    const section = (t: string) => [para(t, true), body()];
    const LONG = 'A much longer title, with a comma, that fails the eight word format limit';
    const blocks = [...section('2.1 First part'), ...section('2.2 Second part'), para(`2.3 ${LONG}`, true), list(BULLETS), ...section('2.4 Fourth part')];
    const sib = detect(blocks).find(c => c.text.startsWith('2.3'));
    expect(sib).toMatchObject({ confidence: 'sibling' });
    expect(evidence(sib)).toContain('followed by a list whose first item is not bold or larger');
    const boldFirst = [...section('2.1 First part'), ...section('2.2 Second part'), para(`2.3 ${LONG}`, true), list(BULLETS, { boldFirst: true }), ...section('2.4 Fourth part')];
    expect(detect(boldFirst).some(c => c.text.startsWith('2.3'))).toBe(false);
  });

  it('the lead-in is lookahead only: it is never a draft of its own, so it is never proposed', () => {
    const blocks = [para('Expected Outcomes', true), list(['Bold-looking line of text', 'second'])];
    const drafts = paragraphDrafts(blocks);
    expect(drafts.map(d => d.index)).toEqual([0]);
    expect(drafts[0].leadsIntoList).toMatchObject({ index: 1, isListLead: true, text: 'Bold-looking line of text' });
    expect(detect(blocks).map(c => c.index)).toEqual([0]);
  });

  it('a paragraph that is not directly followed by a list has no lead-in', () => {
    expect(paragraphDrafts([para('Title', true), body(), list(BULLETS)])[0].leadsIntoList).toBeUndefined();
  });
});
