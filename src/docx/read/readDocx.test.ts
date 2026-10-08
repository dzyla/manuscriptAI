import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import type { JSONContent } from '@tiptap/core';
import { readDocx, type ImportResult } from './index';
import { DocxOpenError, openPackage } from './package';
import { applyHeadings } from './headings';
import { FIDELITY, summarizeReport, type FeatureKey } from '../fidelity';
import { collectFragmentIds } from '../preserve/refs';
import { isBlockUntouched } from '../preserve/hash';
import { parseXml } from '../preserve/xml';
import { getSpecSchema } from '../../extensions/schemaSpecs';
import { M_NS, W_NS } from './ooxml';

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const R_TYPE = REL_NS;

const load = (name: string): ArrayBuffer => {
  const b = readFileSync(new URL(`../../test/fixtures/docx/${name}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

// Nothing in the reader may ever make a request: an external relationship is recorded, never followed. ONE spy for the whole file,
// installed in a file-level beforeAll (which runs before any describe-level one), and checked after EVERY test, so a read done
// anywhere in this file is guarded.
const fetchSpy = vi.fn(() => {
  throw new Error('fetch must never be called while reading a .docx');
});
beforeAll(() => {
  vi.stubGlobal('fetch', fetchSpy);
});
afterAll(() => {
  vi.unstubAllGlobals();
});
beforeEach(() => {
  fetchSpy.mockClear(); // so a request is charged to the test that made it, not to every test after it
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
});

// ─── helpers ───────────────────────────────────────────────────────────────────────────────────────────────

const walk = (n: JSONContent, fn: (x: JSONContent) => void): void => {
  fn(n);
  (n.content ?? []).forEach(c => walk(c, fn));
};
const all = (doc: JSONContent, pred: (n: JSONContent) => boolean): JSONContent[] => {
  const out: JSONContent[] = [];
  walk(doc, n => pred(n) && out.push(n));
  return out;
};
const textOf = (n: JSONContent): string => (n.type === 'text' ? n.text ?? '' : (n.content ?? []).map(textOf).join(''));
const atomsOf = (doc: JSONContent): JSONContent[] => all(doc, n => n.type === 'opaqueInline' || n.type === 'opaqueBlock');
const ofKind = (doc: JSONContent, kind: FeatureKey): JSONContent[] => atomsOf(doc).filter(a => a.attrs!.kind === kind);
const isValid = (doc: JSONContent): boolean => {
  try {
    getSpecSchema().nodeFromJSON(doc).check();
    return true;
  } catch {
    return false;
  }
};
const fragmentOf = (r: ImportResult, atom: JSONContent) => r.preservation.fragments[atom.attrs!.fragmentId as string];
/** The root element of a stored fragment, parsed on its own (no context: only what the fragment declares itself). */
const rootOf = (r: ImportResult, atom: JSONContent): Element => parseXml(fragmentOf(r, atom).xml).documentElement;

const W = `xmlns:w="${W_NS}" xmlns:r="${REL_NS}" xmlns:m="${M_NS}"`;
const wRun = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const SECT = '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>';

/** A small in-test package: just a document part (and whatever else is given), so each adversarial shape is built in one place. */
async function pack(bodyXml: string, extra: Record<string, string | Uint8Array> = {}, rels = ''): Promise<ArrayBuffer> {
  const zip = new JSZip();
  const opts = { date: new Date('2026-01-01T00:00:00Z'), createFolders: false };
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    opts,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R_TYPE}/officeDocument" Target="word/document.xml"/></Relationships>`,
    opts,
  );
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${bodyXml}</w:body></w:document>`, opts);
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
    opts,
  );
  for (const [name, body] of Object.entries(extra)) zip.file(name, body, opts);
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// ─── opaque.docx (generated by scripts/fixtures/make-docx-fixtures.ts) ──────────────────────────────────────────

describe('opaque.docx', () => {
  let r: ImportResult;
  beforeAll(async () => {
    r = await readDocx(load('opaque.docx'));
  });

  it('an m:oMath equation becomes an inline atom of kind equation, stored with the namespaces it needs to re-parse alone', () => {
    const atoms = ofKind(r.doc, 'equation');
    expect(atoms).toHaveLength(1);
    expect(atoms[0].type).toBe('opaqueInline');
    expect(atoms[0].attrs!.label).toBe('equation');
    const root = rootOf(r, atoms[0]);
    expect(root.namespaceURI).toBe(M_NS); // would be null if the m: declaration had not travelled with the fragment
    expect(root.localName).toBe('oMath');
    expect(root.getElementsByTagNameNS(M_NS, 't')[0].textContent).toBe('x+1');
    expect(fragmentOf(r, atoms[0]).nsDecls.m).toBe(M_NS);
    expect(FIDELITY.equation).toBe(3);
    expect(r.report.counts.equation).toBe(1);
  });

  it('a footnote reference becomes a footnoteRef atom that keeps its run formatting; the footnote part itself stays in the original package', async () => {
    const atoms = ofKind(r.doc, 'footnoteRef');
    expect(atoms).toHaveLength(1);
    const root = rootOf(r, atoms[0]);
    expect(root.namespaceURI).toBe(W_NS);
    expect(root.localName).toBe('r'); // the run, so the superscript style travels with the marker
    expect(root.getElementsByTagNameNS(W_NS, 'vertAlign')[0].getAttributeNS(W_NS, 'val')).toBe('superscript');
    expect(root.getElementsByTagNameNS(W_NS, 'footnoteReference')[0].getAttributeNS(W_NS, 'id')).toBe('1');
    expect(FIDELITY.footnoteRef).toBe(3);
    expect(r.report.counts.footnoteRef).toBe(1);
    // the footnote's text is not in the document, but it is not lost: the untouched input still holds it
    expect(textOf(r.doc)).not.toContain('Footnote body text');
    const pkg = await openPackage(r.original);
    expect(pkg.entry('word/footnotes.xml')).toContain('Footnote body text.');
    // and the author is told that it is not shown
    expect(r.report.warnings.some(w => /footnote/i.test(w.message) && w.category === 3)).toBe(true);
  });

  it('a non-Google content control becomes a contentControl atom holding its whole content', () => {
    const atoms = ofKind(r.doc, 'contentControl');
    expect(atoms).toHaveLength(1);
    const root = rootOf(r, atoms[0]);
    expect(root.namespaceURI).toBe(W_NS);
    expect(root.localName).toBe('sdt');
    expect(root.textContent).toBe('controlledtext');
    expect(FIDELITY.contentControl).toBe(3);
    expect(r.report.counts.contentControl).toBe(1);
  });

  it('a bookmarkStart/bookmarkEnd pair becomes two bookmark atoms linked by id, start before end', () => {
    const atoms = ofKind(r.doc, 'bookmark');
    expect(atoms).toHaveLength(2);
    const [start, end] = atoms.map(a => rootOf(r, a));
    expect([start.localName, end.localName]).toEqual(['bookmarkStart', 'bookmarkEnd']);
    expect(start.namespaceURI).toBe(W_NS);
    expect(start.getAttributeNS(W_NS, 'id')).toBe('5');
    expect(end.getAttributeNS(W_NS, 'id')).toBe('5');
    expect(start.getAttributeNS(W_NS, 'name')).toBe('_Ref100');
    // the words between them are ordinary editable text
    const para = all(r.doc, n => n.type === 'paragraph' && atoms.every(a => (n.content ?? []).includes(a)))[0];
    expect(para).toBeDefined();
    const kinds = para.content!.map(c => (c.type === 'text' ? c.text : (c.attrs!.label as string)));
    expect(kinds).toEqual(['Markstart ', 'bookmark', 'markedwords', 'bookmark', ' markend.']);
    expect(FIDELITY.bookmark).toBe(3);
    expect(r.report.counts.bookmark).toBe(2);
  });

  it('a complex field the reader does not model is kept as unknownField atoms; its displayed result stays editable text', () => {
    const atoms = ofKind(r.doc, 'unknownField');
    expect(atoms.map(a => a.attrs!.label)).toEqual(['field start', 'field code', 'field separator', 'field end']);
    const code = rootOf(r, atoms[1]);
    expect(code.getElementsByTagNameNS(W_NS, 'instrText')[0].textContent).toContain('PAGEREF _Ref100');
    expect(textOf(r.doc)).toContain('fieldresult');
    expect(FIDELITY.unknownField).toBe(3);
    expect(r.report.counts.unknownField).toBe(4);
    // not a citation manager's field: no category-2 citation record
    expect(r.report.counts.externalCitation).toBeUndefined();
  });

  it('a w:object OLE object becomes an oleObject atom with its relationship ids recorded', () => {
    const atoms = ofKind(r.doc, 'oleObject');
    expect(atoms).toHaveLength(1);
    const root = rootOf(r, atoms[0]);
    expect(root.localName).toBe('r');
    expect(root.getElementsByTagNameNS(W_NS, 'object')).toHaveLength(1);
    expect(fragmentOf(r, atoms[0]).relIds.sort()).toEqual(['rId40', 'rId41']);
    expect(FIDELITY.oleObject).toBe(3);
    expect(r.report.counts.oleObject).toBe(1);
  });

  it('a paragraph-level sectPr is preserved as a block attribute (the paragraph provenance), not as an atom', () => {
    const para = all(r.doc, n => n.type === 'paragraph' && textOf(n) === 'Sectionone ends here.')[0];
    expect(para).toBeDefined();
    expect(para.content!.every(c => c.type === 'text')).toBe(true); // no atom in it
    const blockId = (para.attrs!.ooxml as { blockId: string }).blockId;
    expect(isBlockUntouched(para)).toBe(true);
    const stored = parseXml(r.preservation.blocks[blockId].xml).documentElement;
    expect(stored.getElementsByTagNameNS(W_NS, 'sectPr')).toHaveLength(1);
    // it is still reported: one section break, category 3, and the app's single page setup is explained
    expect(r.report.counts.sectionBreak).toBe(1);
    expect(FIDELITY.sectionBreak).toBe(3);
    expect(r.report.warnings.some(w => w.feature === 'sectionBreak' && w.category === 3)).toBe(true);
    expect(ofKind(r.doc, 'bookmark')).toHaveLength(2); // and no atom was made for it
    expect(atomsOf(r.doc).some(a => /sectPr|section/i.test(String(a.attrs!.label)))).toBe(false);
  });

  it('byCategory[3] is exactly the opaque atoms plus the section break, and summarizeReport says so', () => {
    const atoms = atomsOf(r.doc);
    expect(atoms).toHaveLength(10); // equation 1, footnote 1, content control 1, bookmarks 2, field pieces 4, object 1
    expect(r.report.byCategory[3]).toBe(atoms.length + (r.report.counts.sectionBreak ?? 0));
    expect(summarizeReport(r.report)).toContain(`${r.report.byCategory[3]} preserved read-only`);
  });

  it('nothing is dropped: every text run is in the document text or in exactly one stored fragment', async () => {
    const pkg = await openPackage(r.original);
    const source = pkg.xml('word/document.xml')!;
    const runs = Array.from(source.getElementsByTagNameNS(W_NS, 't')).map(t => t.textContent ?? '');
    expect(runs.length).toBeGreaterThanOrEqual(15);
    const docText = textOf(r.doc);
    const fragmentTexts = [...Object.values(r.preservation.fragments)].map(f =>
      Array.from(parseXml(f.xml).documentElement.getElementsByTagNameNS(W_NS, 't')).map(t => t.textContent ?? '').join(''),
    );
    const fragmentRuns = new Set(['controlledtext']);
    for (const t of runs) {
      const inDoc = docText.includes(t.trim());
      const inFragments = fragmentTexts.filter(f => f.includes(t)).length;
      if (fragmentRuns.has(t)) {
        expect(inDoc, t).toBe(false);
        expect(inFragments, t).toBe(1);
      } else {
        expect(inDoc, t).toBe(true);
      }
    }
    // the concatenated words come out in document order
    expect(docText).toBe(
      'Equationbefore  equationafter.Notetext noteend.Controlbefore  controlafter.Markstart markedwords markend.Fieldbefore fieldresult fieldafter.Objectbefore  objectafter.Sectionone ends here.Lastparagraph.',
    );
  });

  it('every fragment is referenced by an atom and every atom has a fragment (no orphan, no dangling id)', () => {
    const referenced = collectFragmentIds(r.doc);
    expect([...referenced].sort()).toEqual(Object.keys(r.preservation.fragments).sort());
    for (const a of atomsOf(r.doc)) expect(r.preservation.fragments[a.attrs!.fragmentId as string]).toBeDefined();
  });

  it('preservation.rels holds exactly the relationships the stored XML refers to, with their type and target', () => {
    expect(r.preservation.rels).toEqual({
      rId40: { id: 'rId40', type: `${R_TYPE}/oleObject`, target: 'embeddings/oleObject1.bin' },
      rId41: { id: 'rId41', type: `${R_TYPE}/image`, target: 'media/image1.png' },
    });
  });

  it('the result is a valid document', () => {
    expect(isValid(r.doc)).toBe(true);
    expect(r.format.page.size).toBe('letter');
  });
});

describe('minimal.docx', () => {
  it('reads to a valid document in which every paragraph is untouched', async () => {
    const input = load('minimal.docx');
    const r = await readDocx(input);
    expect(isValid(r.doc)).toBe(true);
    const paragraphs = all(r.doc, n => n.type === 'paragraph' || n.type === 'heading');
    expect(paragraphs.length).toBe(2);
    for (const p of paragraphs) expect(isBlockUntouched(p), textOf(p)).toBe(true);
    expect(r.original).toBe(input);
    expect(r.fileName).toBeUndefined();
    expect(r.assets).toEqual([]);
    expect(r.report.counts.paragraph).toBe(2);
    expect(r.report.warnings).toEqual([]);
  });

  it('carries the file name it is given', async () => {
    expect((await readDocx(load('minimal.docx'), undefined, 'grant.docx')).fileName).toBe('grant.docx');
  });
});

// ─── the assembled pipeline ───────────────────────────────────────────────────────────────────────────────────

describe('images.docx through readDocx (the acceptance check that drawings are read, not left opaque)', () => {
  let r: ImportResult;
  beforeAll(async () => {
    r = await readDocx(load('images.docx')); // after the fetch stub: this fixture holds a linked (external) picture
  });

  it('yields assets and image nodes: three stored images (PNG, PNG, WebP) and six image nodes', () => {
    const images = all(r.doc, n => n.type === 'resizableImage');
    expect(images).toHaveLength(6);
    expect(r.assets.map(a => a.mime).sort()).toEqual(['image/png', 'image/png', 'image/webp']);
    const ids = new Set(r.assets.map(a => a.id));
    const withAsset = images.filter(i => i.attrs!.assetId);
    expect(withAsset).toHaveLength(5); // the linked picture is a placeholder with no bytes
    for (const i of withAsset) expect(ids.has(i.attrs!.assetId as string), String(i.attrs!.alt)).toBe(true);
    expect(r.report.counts.inlineImage).toBe(3);
    expect(r.report.counts.floatingImageSquare).toBe(2);
    expect(r.report.counts.floatingImageOther).toBe(1);
  });

  it('left no picture as an opaque atom except the one whose relationship the document lacks', () => {
    const left = atomsOf(r.doc).filter(a => a.attrs!.label === 'drawing');
    expect(left).toHaveLength(1);
    expect(r.report.warnings.filter(w => /relationship the document does not contain/.test(w.message))).toHaveLength(1);
  });

  it('records every relationship the pictures use, the external link included, and fetched nothing', () => {
    const rels = r.preservation.rels;
    expect(rels.rId30).toEqual({
      id: 'rId30',
      type: `${R_TYPE}/image`,
      target: 'https://example.org/figures/linked.png',
      targetMode: 'External',
    });
    expect(rels.rId20.targetMode).toBeUndefined();
    expect(rels.rId20.target).toBe('media/image1.png');
    expect(fetchSpy).not.toHaveBeenCalled();
    // the one the document lacks is not invented
    const used = new Set<string>();
    for (const f of [...Object.values(r.preservation.blocks), ...Object.values(r.preservation.fragments)]) f.relIds.forEach(id => used.add(id));
    const missing = [...used].filter(id => !rels[id]);
    expect(missing.length).toBe(1);
    expect(Object.keys(rels).sort()).toEqual([...used].filter(id => rels[id]).sort());
  });
});

describe('relationships', () => {
  it('records external hyperlinks without following them, and a dangling id is neither invented nor fatal', async () => {
    const r = await readDocx(load('body-basics.docx'));
    for (const id of ['rId10', 'rId11', 'rId12', 'rId13']) {
      expect(r.preservation.rels[id].targetMode, id).toBe('External');
    }
    expect(r.preservation.rels.rId10.target).toBe('https://example.org/paper');
    expect(r.preservation.rels.rId14.targetMode).toBeUndefined(); // internal
    expect(r.preservation.rels.rId99).toBeUndefined(); // the paragraph's hyperlink to it is dangling in the source
    const dangling = r.report.warnings.filter(w => /relationship/i.test(w.message) && /not (?:defined|in)/i.test(w.message));
    expect(dangling).toHaveLength(1);
    expect(dangling[0].category).toBe(3);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('copies the entries (a writer may edit them without touching the package)', async () => {
    const input = load('opaque.docx');
    const a = await readDocx(input);
    a.preservation.rels.rId40.target = 'tampered';
    const b = await readDocx(input);
    expect(b.preservation.rels.rId40.target).toBe('embeddings/oleObject1.bin');
  });

  it('records the header and footer relationships of the body section, which no fragment holds', async () => {
    const input = await pack(
      `<w:p>${wRun('Body.')}</w:p><w:sectPr><w:headerReference w:type="default" r:id="rId7"/><w:footerReference w:type="default" r:id="rId8"/><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>`,
      { 'word/header1.xml': `<w:hdr ${W}><w:p>${wRun('Running head')}</w:p></w:hdr>`, 'word/footer1.xml': `<w:ftr ${W}><w:p/></w:ftr>` },
      `<Relationship Id="rId7" Type="${R_TYPE}/header" Target="header1.xml"/><Relationship Id="rId8" Type="${R_TYPE}/footer" Target="footer1.xml"/>`,
    );
    const r = await readDocx(input);
    expect(Object.keys(r.preservation.rels).sort()).toEqual(['rId7', 'rId8']);
    expect(r.preservation.rels.rId7.type).toBe(`${R_TYPE}/header`);
    // a header with text is not shown; an empty footer is nothing to report
    const w = r.report.warnings.filter(x => /header/i.test(x.message) && x.category === 3);
    expect(w).toHaveLength(1);
    expect(w[0].message).toMatch(/1 header or footer part has/);
  });
});

describe('headings', () => {
  it('are proposed, not applied: the document keeps its bold paragraphs until the author accepts', async () => {
    const r = await readDocx(load('unstyled-sections.docx'));
    expect(r.headingCandidates.length).toBeGreaterThan(0);
    expect(all(r.doc, n => n.type === 'heading')).toHaveLength(0);
    expect(r.report.counts.inferredHeading).toBe(r.headingCandidates.length);
    expect(r.report.warnings.filter(w => w.feature === 'inferredHeading')).toHaveLength(1);
    // the candidates are positions in exactly this document
    const applied = applyHeadings(r.doc, r.headingCandidates);
    expect(all(applied, n => n.type === 'heading')).toHaveLength(r.headingCandidates.length);
    for (const c of r.headingCandidates) expect(textOf(applied.content![c.index]).trim()).toBe(c.text);
  });

  it('a document that styled its own headings is left alone', async () => {
    const r = await readDocx(load('body-basics.docx'));
    expect(all(r.doc, n => n.type === 'heading').length).toBeGreaterThan(0);
    expect(r.headingCandidates).toEqual([]);
    expect(r.report.counts.inferredHeading).toBeUndefined();
  });
});

describe('page setup and sections', () => {
  it('reads the final section into the format and counts the earlier one as a section break', async () => {
    const r = await readDocx(load('a4-margins.docx'));
    expect(r.format.page.size).toBe('a4');
    expect(r.format.page.marginsIn.left).toBeCloseTo(0.7874, 3);
    expect(r.report.counts.pageSetup).toBe(1);
    expect(r.report.counts.sectionBreak).toBe(1);
    const w = r.report.warnings.filter(x => x.feature === 'sectionBreak');
    expect(w).toHaveLength(1);
    expect(w[0].message).toMatch(/last section/i);
  });

  it('a document with no sectPr at all reads with Word defaults and reports no section break', async () => {
    const r = await readDocx(await pack(`<w:p>${wRun('Plain.')}</w:p>`));
    expect(r.format.page.size).toBe('letter');
    expect(r.format.page.marginsIn).toEqual({ top: 1, right: 1, bottom: 1, left: 1 });
    expect(r.report.counts.sectionBreak).toBeUndefined();
    expect(isValid(r.doc)).toBe(true);
  });

  it('docProps/app.xml supplies the page count only when it is a positive whole number', async () => {
    const app = (pages: string) => `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Pages>${pages}</Pages></Properties>`;
    const rootRel = `<Relationship Id="rId2" Type="${R_TYPE}/extended-properties" Target="docProps/app.xml"/>`;
    const withPages = async (pages: string) => {
      const zip = await JSZip.loadAsync(await pack(`<w:p>${wRun('x')}</w:p>${SECT}`, { 'docProps/app.xml': app(pages) }));
      const rels = await zip.file('_rels/.rels')!.async('string');
      zip.file('_rels/.rels', rels.replace('</Relationships>', `${rootRel}</Relationships>`));
      return (await zip.generateAsync({ type: 'uint8array' })).buffer as ArrayBuffer;
    };
    const ok = await readDocx(await withPages('17'));
    expect(ok.report.pageCount).toBe(17);
    expect(summarizeReport(ok.report)).toContain('17 pages');
    for (const bad of ['0', '-3', 'many', '2.5', '']) expect((await readDocx(await withPages(bad))).report.pageCount, bad).toBeUndefined();
    expect((await readDocx(await pack(`<w:p>${wRun('x')}</w:p>`))).report.pageCount).toBeUndefined();
  });
});

// ─── review state: what the author must be able to rely on ───────────────────────────────────────────────────

describe('review state is reported honestly', () => {
  const ins = (id: number, inner: string) => `<w:ins w:id="${id}" w:author="A" w:date="2026-01-01T00:00:00Z">${inner}</w:ins>`;
  const del = (id: number, inner: string) => `<w:del w:id="${id}" w:author="B" w:date="2026-01-01T00:00:00Z">${inner}</w:del>`;
  const anchors = (id: number, inner: string) =>
    `<w:commentRangeStart w:id="${id}"/>${inner}<w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r>`;

  it('tracked changes, comments and preserved atoms are separate numbers, and each is the true count', async () => {
    const r = await readDocx(
      await pack(
        `<w:p>${wRun('a ')}${ins(1, '<w:r><w:t>new</w:t></w:r>')}${wRun(' b ')}${del(2, '<w:r><w:delText>old</w:delText></w:r>')}</w:p>` +
          `<w:p>${anchors(7, wRun('commented'))}${anchors(8, wRun('also'))}<m:oMath><m:r><m:t>q</m:t></m:r></m:oMath></w:p>${SECT}`,
      ),
    );
    expect(r.report.counts.trackedChange).toBe(2);
    expect(r.report.counts.comment).toBe(2); // two comments, six anchors
    const atoms = atomsOf(r.doc);
    expect(atoms).toHaveLength(2 + 6 + 1);
    expect(r.report.byCategory[3]).toBe(9);
    expect(r.report.described).toEqual({ trackedChange: 2, commentAnchor: 6, citationField: 0 });
    const s = summarizeReport(r.report);
    expect(s).toContain('2 tracked changes');
    expect(s).toContain('2 comments');
    // the 2 revisions and 6 anchors are not counted a second time as "preserved": only the equation is left over
    expect(s).toContain('1 other preserved read-only');
    expect(s).not.toMatch(/\b(?:8|9) (?:other )?preserved/);
    // comments and revisions are not shown yet, and the report says so for each
    expect(r.report.warnings.filter(w => w.feature === 'trackedChange')).toHaveLength(1);
    expect(r.report.warnings.filter(w => w.feature === 'comment' && /text/i.test(w.message))).toHaveLength(1);
    // nothing sits where the reader cannot see it: every revision and comment in the file was met as a piece, none was added afterwards
    expect(r.report.warnings.filter(w => /counted above/i.test(w.message))).toEqual([]);
  });

  it('the four pieces of a reference-manager field are described by the citation count, a field of another kind is "preserved read-only"', async () => {
    const f = (type: string) => `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`;
    const code = (t: string) => `<w:r><w:instrText xml:space="preserve">${t}</w:instrText></w:r>`;
    const field = (instr: string, result: string) => f('begin') + code(instr) + f('separate') + wRun(result) + f('end');
    const r = await readDocx(
      await pack(
        `<w:p>${wRun('See ')}${field(' ADDIN ZOTERO_ITEM CSL_CITATION {}', '[1]')}${wRun(' and ')}${field(' PAGEREF x ', '3')}</w:p>${SECT}`,
      ),
    );
    expect(r.report.counts.externalCitation).toBe(1);
    expect(atomsOf(r.doc)).toHaveLength(8);
    expect(r.report.byCategory[3]).toBe(8);
    expect(r.report.described).toEqual({ trackedChange: 0, commentAnchor: 0, citationField: 4 });
    const s = summarizeReport(r.report);
    expect(s).toContain('1 citation');
    expect(s).toContain('4 other preserved read-only'); // the PAGEREF field's four pieces, and nothing of the citation's
  });

  it('a bibliography field that runs across paragraphs is described by the bibliography count too', async () => {
    const f = (type: string) => `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`;
    const r = await readDocx(
      await pack(
        `<w:p>${f('begin')}<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_BIBL {} CSL_BIBLIOGRAPHY </w:instrText></w:r>${f('separate')}${wRun('entry one')}</w:p>` +
          `<w:p>${wRun('entry two')}</w:p><w:p>${wRun('entry three')}${f('end')}</w:p>${SECT}`,
      ),
    );
    expect(r.report.counts.externalBibliography).toBe(1);
    expect(atomsOf(r.doc)).toHaveLength(4);
    expect(r.report.described!.citationField).toBe(4);
    expect(summarizeReport(r.report)).not.toContain('preserved read-only');
  });

  it('an opaque atom inside another is one atom: counted once, stored once, and its inner relationships travel with it', async () => {
    const r = await readDocx(
      await pack(
        `<w:p>${wRun('lead ')}${ins(1, `<w:r><w:t>insertedtext</w:t></w:r><m:oMath><m:r><m:t>y</m:t></m:r></m:oMath><w:r><w:footnoteReference w:id="3"/></w:r>`)}</w:p>${SECT}`,
      ),
    );
    const atoms = atomsOf(r.doc);
    expect(atoms).toHaveLength(1);
    expect(r.report.byCategory[3]).toBe(1);
    expect(r.report.counts.equation).toBeUndefined();
    expect(r.report.counts.footnoteRef).toBeUndefined();
    expect(r.report.counts.trackedChange).toBe(1);
    const xml = fragmentOf(r, atoms[0]).xml;
    expect(xml).toContain('insertedtext');
    expect(xml).toContain('footnoteReference');
    expect(xml).toContain('oMath');
    expect(Object.keys(r.preservation.fragments)).toHaveLength(1);
  });

  it('revisions and comments that sit INSIDE another preserved piece are added to the totals and disclosed, not silently left out', async () => {
    const r = await readDocx(
      await pack(
        // a tracked insertion that itself holds a tracked deletion (two revisions, one atom), and a content control that holds a comment
        `<w:p>${ins(1, `<w:r><w:t>kept</w:t></w:r>${del(2, '<w:r><w:delText>gone</w:delText></w:r>')}`)}</w:p>` +
          `<w:p><w:sdt><w:sdtPr><w:tag w:val="ctl"/></w:sdtPr><w:sdtContent>${anchors(4, wRun('inside'))}</w:sdtContent></w:sdt></w:p>${SECT}`,
      ),
    );
    // the document holds 2 revisions and 1 comment, so that is what it says, however many atoms there are
    expect(r.report.counts.trackedChange).toBe(2);
    expect(r.report.counts.comment).toBe(1);
    expect(atomsOf(r.doc).filter(a => a.attrs!.label === 'tracked change')).toHaveLength(1); // one atom holds both revisions
    const rev = r.report.warnings.filter(w => w.feature === 'trackedChange' && /counted above/.test(w.message));
    const com = r.report.warnings.filter(w => w.feature === 'comment' && /counted above/.test(w.message));
    expect(rev).toHaveLength(1);
    expect(rev[0].message).toMatch(/^1 tracked change sits /);
    expect(com).toHaveLength(1);
    expect(com[0].message).toMatch(/^1 comment is anchored inside/);
    expect(rev[0].category).toBe(3);
    const s = summarizeReport(r.report);
    expect(s).toContain('2 tracked changes');
    expect(s).toContain('1 comment');
  });

  it('a revision on a paragraph mark or table row is disclosed too', async () => {
    const r = await readDocx(
      await pack(
        `<w:p><w:pPr><w:rPr>${ins(1, '')}</w:rPr></w:pPr>${wRun('markrevised')}</w:p>` +
          `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:trPr>${del(2, '')}</w:trPr><w:tc><w:p>${wRun('cell')}</w:p></w:tc></w:tr></w:tbl>${SECT}`,
      ),
    );
    // two revisions, neither a piece of a paragraph: both are in the count, and the report says where they are
    expect(r.report.counts.trackedChange).toBe(2);
    expect(atomsOf(r.doc)).toHaveLength(0);
    const w = r.report.warnings.filter(x => x.feature === 'trackedChange' && /counted above/.test(x.message));
    expect(w).toHaveLength(1);
    expect(w[0].message).toMatch(/^2 tracked changes sit on a paragraph mark or table row/);
  });
});

// ─── adversarial shapes ──────────────────────────────────────────────────────────────────────────────────────

describe('adversarial documents', () => {
  it('every block opaque: no paragraph at all still reads, validates, and every piece is stored and counted', async () => {
    const r = await readDocx(
      await pack(
        `<w:sdt><w:sdtPr><w:tag w:val="a"/></w:sdtPr><w:sdtContent><w:p>${wRun('boxed')}</w:p></w:sdtContent></w:sdt>` +
          `<m:oMathPara><m:oMath><m:r><m:t>z</m:t></m:r></m:oMath></m:oMathPara>` +
          `<w:bookmarkStart w:id="1" w:name="b"/><w:bookmarkEnd w:id="1"/>` +
          `<w:customXml w:uri="urn:x" w:element="e"><w:p>${wRun('custom')}</w:p></w:customXml>${SECT}`,
      ),
    );
    const blocks = r.doc.content!;
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    expect(blocks.every(b => b.type === 'opaqueBlock')).toBe(true);
    expect(isValid(r.doc)).toBe(true);
    expect(r.report.byCategory[3]).toBe(blocks.length);
    expect(Object.keys(r.preservation.fragments)).toHaveLength(blocks.length);
    expect(Object.keys(r.preservation.blocks)).toHaveLength(0);
    expect(r.headingCandidates).toEqual([]);
    expect(r.report.counts.paragraph).toBeUndefined();
    expect(summarizeReport(r.report)).toContain(`${blocks.length} preserved read-only`);
    for (const b of blocks) expect(parseXml(r.preservation.fragments[b.attrs!.fragmentId as string].xml).documentElement).toBeDefined();
  });

  it('an empty body still yields a valid document (one empty paragraph with no provenance claim)', async () => {
    const r = await readDocx(await pack(SECT));
    expect(isValid(r.doc)).toBe(true);
    expect(r.doc.content).toHaveLength(1);
    expect(r.doc.content![0].type).toBe('paragraph');
    expect(r.doc.content![0].attrs!.ooxml ?? null).toBeNull();
    expect(Object.keys(r.preservation.blocks)).toHaveLength(0);
  });

  it('a package with no main document part is refused with a typed error, not a TypeError', async () => {
    const zip = await JSZip.loadAsync(await pack(`<w:p/>`));
    zip.remove('word/document.xml');
    const bytes = (await zip.generateAsync({ type: 'uint8array' })).buffer as ArrayBuffer;
    await expect(readDocx(bytes)).rejects.toBeInstanceOf(DocxOpenError);
  });

  it('a body-less document part is refused with a typed error', async () => {
    const zip = await JSZip.loadAsync(await pack(`<w:p/>`));
    zip.file('word/document.xml', `<w:document ${W}/>`);
    const bytes = (await zip.generateAsync({ type: 'uint8array' })).buffer as ArrayBuffer;
    await expect(readDocx(bytes)).rejects.toMatchObject({ name: 'DocxOpenError', code: 'corrupt' });
  });

  it('the package limits and macro refusal pass straight through', async () => {
    await expect(readDocx(load('bomb.docx'))).rejects.toMatchObject({ code: 'bomb' });
    await expect(readDocx(load('macro.docm'))).rejects.toMatchObject({ code: 'macro' });
    await expect(readDocx(load('minimal.docx'), { maxEntries: 1 })).rejects.toMatchObject({ code: 'too-many-entries' });
  });

  it('reading the same bytes twice, one after the other or at the same time, gives identical results (no state shared between reads)', async () => {
    const names = ['opaque.docx', 'images.docx', 'tables.docx', 'lists.docx', 'unstyled-sections.docx', 'body-basics.docx'];
    const strip = (r: ImportResult) => ({ ...r, original: undefined });
    const first = [];
    for (const n of names) first.push(strip(await readDocx(load(n))));
    const again = [];
    for (const n of names) again.push(strip(await readDocx(load(n))));
    expect(again).toEqual(first);
    const together = (await Promise.all(names.map(n => readDocx(load(n))))).map(strip);
    expect(together).toEqual(first);
    // and the summary is a pure function of the report
    for (const r of first) expect(summarizeReport(r.report)).toBe(summarizeReport(JSON.parse(JSON.stringify(r.report))));
  });

  it('the report is plain data: it survives structured cloning unchanged', async () => {
    const r = await readDocx(load('opaque.docx'));
    const copy = structuredClone({ ...r, original: undefined });
    expect(copy.report).toEqual(r.report);
    expect(copy.doc).toEqual(r.doc);
    expect(copy.preservation).toEqual(r.preservation);
  });
});
