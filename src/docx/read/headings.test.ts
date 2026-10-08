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

  it('detects a short bold line that names no section as a format match, one level below a preceding level-1 heading', () => {
    const c = byText(found, 'Aim 1: Define the mechanism');
    expect(c).toMatchObject({ level: 2, confidence: 'format' });
    expect(c!.evidence.join(' | ')).toMatch(/bold/i);
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
    expect(JSON.stringify(styled.report)).toBe(before);
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
