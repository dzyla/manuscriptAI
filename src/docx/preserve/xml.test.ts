import { describe, it, expect } from 'vitest';
import { parseXml, parseXmlStrict, captureFragment, captureChildren, remapRelIds, allocateRelIds, collectFragmentIds, pruneFragments } from './xml';
import { emptyPreservationStore } from './types';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';

const DOC = `<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:m="${M}"><w:body>
<w:p><w:r><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="rId7"/></w:drawing></w:r>
<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></w:p></w:body></w:document>`;

describe('captureFragment', () => {
  it('captures in-scope namespace declarations and relationship ids', () => {
    const doc = parseXml(DOC);
    const p = doc.getElementsByTagNameNS(W, 'p')[0];
    const f = captureFragment(p);
    expect(f.relIds).toEqual(['rId7']);
    expect(f.nsDecls).toMatchObject({ w: W, r: R, m: M });
    // fragment is self-contained: it re-parses on its own with namespaces resolved
    const re = parseXml(f.xml);
    expect(re.documentElement.namespaceURI).toBe(W);
    expect(re.getElementsByTagNameNS(M, 'oMath').length).toBe(1);
  });

  it('captures a leaf element (equation) with ancestor namespaces', () => {
    const doc = parseXml(DOC);
    const math = doc.getElementsByTagNameNS(M, 'oMath')[0];
    const f = captureFragment(math);
    expect(f.relIds).toEqual([]);
    expect(parseXml(f.xml).documentElement.localName).toBe('oMath');
  });
});

describe('remapRelIds / allocateRelIds', () => {
  it('rewrites relationship attributes only', () => {
    const f = captureFragment(parseXml(DOC).getElementsByTagNameNS(W, 'p')[0]);
    const g = remapRelIds(f, { rId7: 'rId12' });
    expect(g.relIds).toEqual(['rId12']);
    expect(g.xml).toContain('r:embed="rId12"');
    expect(g.xml).not.toContain('rId7');
  });

  it('keeps free ids and renames taken ones', () => {
    const m = allocateRelIds(['rId1', 'rId5'], new Set(['rId1', 'rId2']));
    expect(m.rId5).toBe('rId5');
    expect(m.rId1).not.toBe('rId1');
    expect(['rId1', 'rId2', 'rId5']).not.toContain(m.rId1);
  });
});

describe('fragment bookkeeping', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'opaqueInline', attrs: { kind: 'equation', label: 'equation', fragmentId: 'f1' } }] },
      { type: 'opaqueBlock', attrs: { kind: 'sdt', label: 'content control', fragmentId: 'f2' } },
    ],
  };

  it('collects fragment ids at any depth', () => {
    expect([...collectFragmentIds(doc)].sort()).toEqual(['f1', 'f2']);
  });

  it('prunes unreferenced fragments only', () => {
    const s = emptyPreservationStore();
    s.fragments = { f1: { xml: '<a/>', relIds: [], nsDecls: {} }, f9: { xml: '<b/>', relIds: [], nsDecls: {} } };
    const out = pruneFragments(s, new Set(['f1']));
    expect(Object.keys(out.fragments)).toEqual(['f1']);
    expect(s.fragments.f9).toBeDefined(); // input not mutated
  });
});

describe('parseXmlStrict', () => {
  it('parses well-formed XML, with or without a BOM, and an empty root', () => {
    expect(parseXmlStrict(DOC).documentElement.localName).toBe('document');
    expect(parseXmlStrict('\uFEFF<a><b/></a>\n').documentElement.localName).toBe('a');
    expect(parseXmlStrict('<a/>').documentElement.localName).toBe('a');
  });

  it('accepts legal trailing syntax after the root', () => {
    expect(parseXmlStrict('<w:a xmlns:w="urn:x"><w:b/></w:a >').documentElement.nodeName).toBe('w:a');
    expect(parseXmlStrict('<a><b/></a>\n<!-- note -->\n<?pi x?>\n').documentElement.nodeName).toBe('a');
    expect(parseXmlStrict('<a x="1"/> <!-- note -->').documentElement.nodeName).toBe('a');
  });

  it('rejects content after the root and an unterminated trailing comment', () => {
    expect(() => parseXmlStrict('<a><b/></a>junk')).toThrow();
    expect(() => parseXmlStrict('<a><b/></a><!-- never closed')).toThrow();
  });

  it.each([
    ['cut inside text', '<a><b>hi'],
    ['cut at a tag boundary', '<a><b></b>'],
    ['mismatched close', '<a><b></a>'],
    ['empty input', ''],
    ['undefined entity', '<a>&bogus;</a>'],
    ['DTD with entity', '<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>'],
  ])('throws for %s', (_label, xml) => {
    expect(() => parseXmlStrict(xml)).toThrow();
  });
});

describe('captureChildren', () => {
  it('keeps only the chosen children, self-contained, with the container attributes', () => {
    const doc = parseXml(`<w:styles xmlns:w="${W}" xmlns:m="${M}"><w:style w:styleId="X"><w:keepNext/><w:name w:val="x"/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:style></w:styles>`);
    const style = doc.getElementsByTagNameNS(W, 'style')[0];
    const keep = [style.getElementsByTagNameNS(W, 'keepNext')[0], style.getElementsByTagNameNS(W, 'tabs')[0]];
    const xml = captureChildren(style, keep);
    const re = parseXml(xml);
    expect(re.documentElement.localName).toBe('style');
    expect(re.documentElement.getAttributeNS(W, 'styleId')).toBe('X');
    expect(re.getElementsByTagNameNS(W, 'name').length).toBe(0);
    expect(re.getElementsByTagNameNS(W, 'tab').length).toBe(1);
    expect(xml).not.toContain('xmlns:m='); // only the namespaces the fragment uses are declared
    expect(xml).toContain(`xmlns:w="${W}"`);
    expect(style.getElementsByTagNameNS(W, 'name').length).toBe(1); // source untouched
  });

  it('declares a namespace the kept content uses, including prefixed attributes and mc:Ignorable tokens', () => {
    const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
    const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
    const doc = parseXml(`<w:styles xmlns:w="${W}" xmlns:m="${M}" xmlns:w14="${W14}" xmlns:mc="${MC}"><w:style w:styleId="X" mc:Ignorable="w14"><w:rPr><w14:ligatures w14:val="all"/><w:b/></w:rPr><w:other/></w:style></w:styles>`);
    const rPr = doc.getElementsByTagNameNS(W, 'rPr')[0];
    const xml = captureChildren(rPr, [rPr.firstChild as Element]);
    expect(xml).toContain('xmlns:w14=');
    expect(xml).not.toContain('xmlns:m=');
    const re = parseXml(xml);
    expect(re.getElementsByTagNameNS(W14, 'ligatures').length).toBe(1);
    // Ignorable on the container: the tokens it names must stay declared
    const style = doc.getElementsByTagNameNS(W, 'style')[0];
    const kept = captureChildren(style, [style.getElementsByTagNameNS(W, 'other')[0]]);
    expect(kept).toContain('xmlns:w14=');
    expect(kept).toContain('xmlns:mc=');
    expect(kept).not.toContain('xmlns:m=');
  });
});

describe('captureFragment: namespace trimming', () => {
  const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
  const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
  const WIDE = `<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:m="${M}" xmlns:w14="${W14}" xmlns:mc="${MC}" xmlns:wp="urn:x:wp" xmlns:v="urn:x:v" xmlns:o="urn:x:o"><w:body><w:p><w:r><w:t>plain</w:t></w:r></w:p><w:p><w:r><w:rPr><w14:ligatures w14:val="all"/></w:rPr><w:drawing r:id="rId9"/></w:r><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></w:p><w:p mc:Ignorable="w14"><w:r><w:t>y</w:t></w:r></w:p></w:body></w:document>`;
  const paras = () => parseXml(WIDE).getElementsByTagNameNS(W, 'p');
  const declCount = (xml: string) => (xml.match(/xmlns(:\w+)?=/g) ?? []).length;

  it('declares only the prefixes a plain paragraph uses', () => {
    const f = captureFragment(paras()[0]);
    expect(declCount(f.xml)).toBe(1);
    expect(f.nsDecls).toEqual({ w: W });
    expect(parseXml(f.xml).documentElement.namespaceURI).toBe(W);
  });

  it('keeps element, attribute and Ignorable-named prefixes, and re-parses standalone', () => {
    const f = captureFragment(paras()[1]);
    expect(Object.keys(f.nsDecls).sort()).toEqual(['m', 'r', 'w', 'w14']);
    expect(f.xml).not.toContain('xmlns:v=');
    const re = parseXml(f.xml);
    expect(re.getElementsByTagNameNS(W14, 'ligatures').length).toBe(1);
    expect(re.getElementsByTagNameNS(M, 'oMath').length).toBe(1);
    expect(f.relIds).toEqual(['rId9']);
    const ign = captureFragment(paras()[2]);
    expect(Object.keys(ign.nsDecls).sort()).toEqual(['mc', 'w', 'w14']);
  });

  it('survives remapRelIds with its trimmed declarations intact', () => {
    const f = remapRelIds(captureFragment(paras()[1]), { rId9: 'rId42' });
    expect(f.xml).toContain('rId42');
    expect(Object.keys(f.nsDecls).sort()).toEqual(['m', 'r', 'w', 'w14']);
    expect(parseXml(f.xml).getElementsByTagNameNS(W, 'drawing').length).toBe(1);
  });

  it('is much smaller than declaring everything in scope', () => {
    const f = captureFragment(paras()[0]);
    expect(f.xml.length).toBeLessThan(120);
  });
});
