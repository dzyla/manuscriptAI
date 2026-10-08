import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { openPackage } from './package';
import { readStyles } from './styles';
import { readPageSetup } from './pageSetup';
import { resolveRelTarget } from './opc';
import { twipsToIn, inToTwips, halfPointsToPt, ptToHalfPoints, emuToIn, inToEmu, eighthPointsToPt } from './units';
import { resolveStyle } from '../../services/formatPresets';
import { createReport } from '../fidelity';
import { parseXml } from '../preserve/xml';

const load = (name: string): ArrayBuffer => {
  const b = readFileSync(new URL(`../../test/fixtures/docx/${name}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe('units', () => {
  it('converts the OOXML units exactly', () => {
    expect(twipsToIn(1440)).toBe(1);
    expect(twipsToIn(720)).toBe(0.5);
    expect(halfPointsToPt(22)).toBe(11);
    expect(emuToIn(914400)).toBe(1);
    expect(eighthPointsToPt(4)).toBe(0.5);
  });

  it('round-trips through the inverse conversions', () => {
    expect(inToTwips(twipsToIn(1134))).toBe(1134);
    expect(ptToHalfPoints(halfPointsToPt(23))).toBe(23);
    expect(inToEmu(emuToIn(457200))).toBe(457200);
  });
});

describe('readStyles', () => {
  it('reads document defaults', async () => {
    const { format } = readStyles(await openPackage(load('styles.docx')));
    expect(format.defaults).toEqual({ fontFamily: 'Arial', fontSizePt: 11 });
    expect(format.preset).toBe('custom');
  });

  it('maps Word style ids to app style ids and keeps the display name', async () => {
    const { format, styleIdByWordId } = readStyles(await openPackage(load('styles.docx')));
    expect(styleIdByWordId.get('Heading1')).toBe('heading1');
    expect(format.styles.heading1.name).toBe('heading 1');
    const custom = styleIdByWordId.get('aimTitle')!;
    expect(format.styles[custom].name).toBe('Aim Title');
    expect(format.styles[custom].align).toBe('center');
  });

  it('identifies headings by outlineLvl, by inheritance and by name', async () => {
    const { headingLevelByStyleId, styleIdByWordId } = readStyles(await openPackage(load('styles.docx')));
    expect(headingLevelByStyleId.get('heading1')).toBe(1);
    expect(headingLevelByStyleId.get('heading2')).toBe(2);
    expect(headingLevelByStyleId.get(styleIdByWordId.get('SubAim')!)).toBe(2); // inherits Heading2's outline level
    expect(headingLevelByStyleId.get(styleIdByWordId.get('Titre3')!)).toBe(3); // localised id, matched by name
    expect(headingLevelByStyleId.has('normal')).toBe(false);
    expect(headingLevelByStyleId.has(styleIdByWordId.get('Chain3')!)).toBe(false);
  });

  it('keeps the basedOn chain rather than flattening it', async () => {
    const { format, styleIdByWordId } = readStyles(await openPackage(load('styles.docx')));
    expect(format.styles.heading2.basedOn).toBe('heading1');
    expect(format.styles.heading2.bold).toBeUndefined(); // not copied down from heading1
    const c3 = format.styles[styleIdByWordId.get('Chain3')!];
    expect(c3.basedOn).toBe(styleIdByWordId.get('Chain2'));
    // three deep, and the app's own resolver walks it
    const r = resolveStyle(format, styleIdByWordId.get('Chain3')!);
    expect(r.bold).toBe(true);
    expect(r.italic).toBe(true);
    expect(r.color).toBe('#c00000');
  });

  it('reads the modelled run and paragraph properties', async () => {
    const { format } = readStyles(await openPackage(load('styles.docx')));
    const h1 = format.styles.heading1;
    expect(h1).toMatchObject({ type: 'paragraph', bold: true, fontSizePt: 14, color: '#2e74b5', spaceBeforePt: 12, spaceAfterPt: 0, next: 'normal' });
    expect(h1.preserved?.pPrXml).toContain('outlineLvl'); // not modelled by StyleDef, so kept
    expect(h1.preserved?.pPrXml).not.toContain('spacing');
    expect(h1.preserved?.rPrXml).toBeUndefined(); // everything in its rPr was modelled
  });

  it('reads line spacing rules, indents and alignment', async () => {
    const { format, styleIdByWordId } = readStyles(await openPackage(load('styles.docx')));
    const s = format.styles[styleIdByWordId.get('KeepTabs')!];
    expect(s.lineSpacing).toEqual({ rule: 'exact', value: 18 });
    expect(s.indent).toEqual({ leftIn: 0.5, hangingIn: 0.25 });
    expect(s.align).toBe('justify');
    expect(s.spaceBeforePt).toBe(6);
    expect(s.spaceAfterPt).toBe(3);
    expect(s.fontSizePt).toBe(10);
  });

  it('applies docDefaults paragraph properties to the default paragraph style', async () => {
    const { format } = readStyles(await openPackage(load('styles.docx')));
    expect(format.styles.normal.lineSpacing?.rule).toBe('auto');
    expect(format.styles.normal.lineSpacing?.value).toBeCloseTo(259 / 240, 3);
    expect(format.styles.normal.spaceAfterPt).toBe(8);
    // a style that sets its own spacing keeps it
    expect(format.styles.heading1.spaceAfterPt).toBe(0);
  });

  it('reads character styles', async () => {
    const { format, styleIdByWordId } = readStyles(await openPackage(load('styles.docx')));
    const id = styleIdByWordId.get('Emphasis')!;
    expect(format.styles[id].type).toBe('character');
    expect(format.styles[id].italic).toBe(true);
  });

  it('preserves unmodelled style properties verbatim', async () => {
    const { format } = readStyles(await openPackage(load('styles.docx')));
    const withKeep = Object.values(format.styles).find(s => s.preserved?.pPrXml?.includes('keepNext'));
    expect(withKeep).toBeDefined();
    expect(withKeep!.preserved!.pPrXml).toContain('w:tabs');
    expect(withKeep!.preserved!.pPrXml).toContain('w:pos="720"');
    // the preserved fragment is self-contained and re-parses
    expect(parseXml(withKeep!.preserved!.pPrXml!).documentElement.localName).toBe('pPr');
  });

  it('keeps run properties it cannot map (theme fonts, caps) rather than dropping them', async () => {
    const { format, styleIdByWordId } = readStyles(await openPackage(load('styles.docx')));
    const s = format.styles[styleIdByWordId.get('KeepTabs')!];
    expect(s.preserved?.rPrXml).toContain('caps');
    expect(s.preserved?.rPrXml).toContain('asciiTheme');
    expect(s.preserved?.rPrXml).not.toContain('w:sz'); // size was modelled
  });

  it('keeps non-pPr/rPr style children (links, priorities, table properties)', async () => {
    const { format, styleIdByWordId } = readStyles(await openPackage(load('styles.docx')));
    expect(format.styles.heading1.preserved?.extraXml).toContain('w:link');
    expect(format.styles.heading1.preserved?.extraXml).toContain('w:uiPriority');
    const table = format.styles[styleIdByWordId.get('TableGrid')!];
    expect(table.type).toBe('table');
    expect(table.preserved?.extraXml).toContain('w:tblBorders');
  });

  it('keeps a dangling basedOn instead of inventing a base, and breaks cycles', async () => {
    const { format, styleIdByWordId } = readStyles(await openPackage(load('styles.docx')));
    const dangling = format.styles[styleIdByWordId.get('Dangling')!];
    expect(dangling.basedOn).toBeUndefined();
    expect(dangling.preserved?.extraXml).toContain('NoSuchStyle');
    const a = format.styles[styleIdByWordId.get('CycA')!];
    const b = format.styles[styleIdByWordId.get('CycB')!];
    expect([a.basedOn, b.basedOn].filter(Boolean).length).toBe(1); // exactly one edge cut
    expect(a.preserved?.extraXml ?? b.preserved?.extraXml).toContain('basedOn');
  });

  it('every basedOn / next reference resolves to a style in the format', async () => {
    const { format } = readStyles(await openPackage(load('styles.docx')));
    for (const s of Object.values(format.styles)) {
      if (s.basedOn) expect(format.styles[s.basedOn], `${s.id}.basedOn`).toBeDefined();
      if (s.next) expect(format.styles[s.next], `${s.id}.next`).toBeDefined();
    }
  });

  it('records what it understood in the import report', async () => {
    const report = createReport();
    readStyles(await openPackage(load('styles.docx')), report);
    expect(report.counts.paragraphStyle).toBeGreaterThan(5);
    expect(report.counts.characterStyle).toBe(2);
    expect(report.counts.tabStops).toBe(1);
    expect(report.counts.keepRules).toBe(1);
    expect(report.counts.tableBorders).toBe(1);
    expect(report.warnings.some(w => /basedOn/.test(w.message))).toBe(true);
  });

  it('backfills built-in styles the document lacks, from the NIH preset, on top of its own', async () => {
    const { format, styleIdByWordId } = readStyles(await openPackage(load('minimal.docx')));
    expect(format.preset).toBe('custom');
    expect(format.styles.normal).toBeDefined();
    expect(format.styles.heading2).toBeDefined();
    expect(format.styles.caption).toBeDefined();
    expect(format.defaults.fontSizePt).toBeGreaterThan(0);
    // backfilled styles are distinguishable from the document's own
    expect(styleIdByWordId.has('Heading1')).toBe(true);
    expect([...styleIdByWordId.values()]).not.toContain('heading2');
  });

  it('falls back to the NIH preset when styles.xml is missing', async () => {
    const report = createReport();
    const { format, styleIdByWordId, headingLevelByStyleId } = readStyles(await openPackage(load('no-styles.docx')), report);
    expect(format.preset).toBe('nih');
    expect(format.styles.normal).toBeDefined();
    expect(format.defaults.fontSizePt).toBeGreaterThan(0);
    expect(styleIdByWordId.size).toBe(0);
    expect(headingLevelByStyleId.size).toBe(0);
  });

  it('degrades to the NIH preset, with a warning, when styles.xml is malformed', async () => {
    const report = createReport();
    const { format } = readStyles(await openPackage(load('bad-styles.docx')), report);
    expect(format.preset).toBe('nih');
    expect(report.warnings.some(w => w.feature === 'part' && /styles\.xml/.test(w.message))).toBe(true);
  });

  it('does not treat a deferred styles.xml as absent', async () => {
    const pkg = await openPackage(load('minimal.docx'), { maxEagerBytes: 700 });
    expect(pkg.isDeferred('word/styles.xml')).toBe(true);
    expect(() => readStyles(pkg)).toThrowError(expect.objectContaining({ code: 'too-large' }));
  });

  it('follows the styles relationship to a non-conventional part name', async () => {
    const zip = await JSZip.loadAsync(load('styles.docx'));
    const styles = await zip.file('word/styles.xml')!.async('string');
    zip.remove('word/styles.xml');
    zip.file('word/custom/Look Book.xml', styles);
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string');
    zip.file('word/_rels/document.xml.rels', rels.replace('Target="styles.xml"', 'Target="custom/Look%20Book.xml"'));
    const ct = await zip.file('[Content_Types].xml')!.async('string');
    zip.file('[Content_Types].xml', ct.replace('/word/styles.xml', '/word/custom/Look Book.xml'));
    const pkg = await openPackage(await zip.generateAsync({ type: 'arraybuffer' }));
    const { format } = readStyles(pkg);
    expect(format.preset).toBe('custom');
    expect(format.styles.heading1.bold).toBe(true);
  });

  it('does not let a relationship escape the package to find styles', async () => {
    const zip = await JSZip.loadAsync(load('styles.docx'));
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string');
    zip.file('word/_rels/document.xml.rels', rels.replace('Target="styles.xml"', 'Target="../../styles.xml"'));
    const { format } = readStyles(await openPackage(await zip.generateAsync({ type: 'arraybuffer' })));
    // the escaping target is ignored; the conventional word/styles.xml is used
    expect(format.styles.heading1.bold).toBe(true);
  });

  it('never lets a hostile style id collide with Object.prototype members', async () => {
    const zip = await JSZip.loadAsync(load('styles.docx'));
    const styles = await zip.file('word/styles.xml')!.async('string');
    const hostile = ['__proto__', 'constructor', 'toString', 'hasOwnProperty']
      .map(id => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${id}"/><w:rPr><w:b/></w:rPr></w:style>`)
      .join('');
    zip.file('word/styles.xml', styles.replace('</w:styles>', `${hostile}</w:styles>`));
    const { format, styleIdByWordId } = readStyles(await openPackage(await zip.generateAsync({ type: 'arraybuffer' })));
    expect(Object.getPrototypeOf(format.styles)).toBe(Object.prototype);
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const app = styleIdByWordId.get(id)!;
      expect(Object.prototype.hasOwnProperty.call(format.styles, app)).toBe(true);
      expect(format.styles[app].bold).toBe(true);
    }
  });
});

describe('readStyles: Word attributes, localised built-ins and derived defaults', () => {
  const localised = async (report?: ReturnType<typeof createReport>) => readStyles(await openPackage(load('localised-styles.docx')), report);

  it('keeps w:customStyle and w:default on the style even when nothing else is unmodelled', async () => {
    const { format, styleIdByWordId } = await localised();
    const only = format.styles[styleIdByWordId.get('OnlyBold')!];
    expect(only.customStyle).toBe(true);
    expect(only.bold).toBe(true);
    expect(only.preserved).toBeUndefined(); // nothing opaque was needed: the flag lives on the StyleDef
    expect(format.styles.normal.wordDefault).toBe(true);
    const english = readStyles(await openPackage(load('styles.docx'))).format;
    expect(english.styles.normal.wordDefault).toBe(true);
    expect(english.styles.heading1.customStyle).toBeUndefined();
  });

  it('warns about a style with no styleId instead of skipping it silently', async () => {
    const report = createReport();
    const { format } = await localised(report);
    expect(report.warnings.some(w => /without a styleId/.test(w.message))).toBe(true);
    expect(Object.values(format.styles).some(s => s.name === 'No Id')).toBe(false);
  });

  it('maps localised built-in styles onto the app built-ins by w:name, not by styleId', async () => {
    const { format, styleIdByWordId, headingLevelByStyleId, backfilled } = await localised();
    expect(styleIdByWordId.get('Standard')).toBe('normal');
    expect(styleIdByWordId.get('Titre1')).toBe('heading1');
    expect(styleIdByWordId.get('\u00dcberschrift2')).toBe('heading2');
    expect(styleIdByWordId.get('Legende')).toBe('caption');
    expect(headingLevelByStyleId.get('heading1')).toBe(1);
    expect(headingLevelByStyleId.get('heading2')).toBe(2);
    expect(format.styles.heading1.basedOn).toBe('normal');
    expect(format.styles.heading1.name).toBe('heading 1');
    // no duplicate "heading 1" appears, and the app's heading1 IS the document's
    expect(Object.values(format.styles).filter(s => s.name.toLowerCase() === 'heading 1')).toHaveLength(1);
    expect(Object.values(format.styles).filter(s => s.name.toLowerCase() === 'normal')).toHaveLength(1);
    for (const own of ['normal', 'heading1', 'heading2', 'caption']) expect(backfilled.has(own), own).toBe(false);
    // only what the document lacks is backfilled
    expect([...backfilled].sort()).toEqual(['bibliography', 'heading3']);
    expect(format.styles.normal.wordDefault).toBe(true);
  });

  it('reports the backfilled set explicitly', async () => {
    const minimal = readStyles(await openPackage(load('minimal.docx')));
    expect(minimal.backfilled.has('normal')).toBe(true);
    expect(minimal.backfilled.has('heading2')).toBe(true);
    expect(minimal.backfilled.has('heading1')).toBe(false); // the document defines Heading1
    for (const id of minimal.styleIdByWordId.values()) expect(minimal.backfilled.has(id)).toBe(false);
    const none = readStyles(await openPackage(load('no-styles.docx')));
    expect([...none.backfilled].sort()).toEqual(Object.keys(none.format.styles).sort());
  });

  it('marks values copied from docDefaults as derived, and never marks declared ones', async () => {
    const { format, styleIdByWordId } = await localised();
    expect(format.styles.normal.spaceAfterPt).toBe(8);
    expect(format.styles.normal.derivedFromDefaults).toEqual(['spaceAfterPt', 'lineSpacing']);
    // a style that inherits from Normal gets nothing copied (the resolver walks basedOn)
    expect(format.styles.heading2.derivedFromDefaults).toBeUndefined();
    expect(format.styles.heading2.spaceAfterPt).toBeUndefined();
    // a root paragraph style that is not the default also inherits docDefaults in Word
    const root = format.styles[styleIdByWordId.get('Rootless')!];
    expect(root.spaceBeforePt).toBe(5); // declared, kept
    expect(root.derivedFromDefaults).toEqual(['spaceAfterPt', 'lineSpacing']);
    expect(root.spaceAfterPt).toBe(8);
    // declared values are never listed
    expect(format.styles.heading1.spaceAfterPt).toBe(0);
    expect(format.styles.heading1.derivedFromDefaults).toBeUndefined();
    // table styles are not paragraph styles
    const table = format.styles[styleIdByWordId.get('TableauNormal')!];
    expect(table.derivedFromDefaults).toBeUndefined();
    expect(table.spaceAfterPt).toBeUndefined();
    expect(table.wordDefault).toBe(true);
  });

  it('puts the derived defaults on a synthesised normal when the document has no Normal style', async () => {
    const zip = await JSZip.loadAsync(load('localised-styles.docx'));
    const styles = await zip.file('word/styles.xml')!.async('string');
    zip.file('word/styles.xml', styles.replace('<w:name w:val="Normal"/>', '<w:name w:val="Corps"/>'));
    const { format, backfilled } = readStyles(await openPackage(await zip.generateAsync({ type: 'arraybuffer' })));
    expect(backfilled.has('normal')).toBe(true);
    expect(format.styles.normal.basedOn).toBe('standard'); // the document's own default style
    expect(format.styles.standard.derivedFromDefaults).toEqual(['spaceAfterPt', 'lineSpacing']);
    expect(format.styles.normal.derivedFromDefaults).toBeUndefined();
  });

  const withExtraStyles = async (xml: string) => {
    const zip = await JSZip.loadAsync(load('localised-styles.docx'));
    const styles = await zip.file('word/styles.xml')!.async('string');
    zip.file('word/styles.xml', styles.replace('</w:styles>', `${xml}</w:styles>`));
    return readStyles(await openPackage(await zip.generateAsync({ type: 'arraybuffer' })));
  };

  it('counts a value as declared when the style states it, even if it equals the docDefault', async () => {
    const { format, styleIdByWordId } = await withExtraStyles(
      '<w:style w:type="paragraph" w:customStyle="1" w:styleId="SameAsDefault"><w:name w:val="Same As Default"/><w:pPr><w:spacing w:after="160"/></w:pPr></w:style>',
    );
    const s = format.styles[styleIdByWordId.get('SameAsDefault')!];
    expect(s.spaceAfterPt).toBe(8); // equal to the docDefault, but written by the style
    expect(s.derivedFromDefaults).toEqual(['lineSpacing']); // only what it did NOT state
  });

  it('gives a built-in name to the first style that holds it; a later same-name style falls back to its id', async () => {
    const { format, styleIdByWordId, headingLevelByStyleId } = await withExtraStyles(
      '<w:style w:type="paragraph" w:styleId="FirstH3"><w:name w:val="heading 3"/><w:rPr><w:b/></w:rPr></w:style>' +
        '<w:style w:type="paragraph" w:customStyle="1" w:styleId="SecondH3"><w:name w:val="Heading 3"/><w:rPr><w:i/></w:rPr></w:style>',
    );
    expect(styleIdByWordId.get('FirstH3')).toBe('heading3');
    expect(styleIdByWordId.get('SecondH3')).toBe('secondH3');
    expect(format.styles.heading3.bold).toBe(true);
    expect(format.styles.secondH3.italic).toBe(true);
    expect(format.styles.secondH3.name).toBe('Heading 3'); // the document's name is kept
    expect(headingLevelByStyleId.get('heading3')).toBe(3);
    expect(headingLevelByStyleId.get('secondH3')).toBe(3); // still recognised as a heading by name
  });

  it('declares only the namespaces a preserved fragment uses', async () => {
    const { format } = await localised();
    const frags = Object.values(format.styles).flatMap(s => Object.values(s.preserved ?? {}));
    expect(frags.length).toBeGreaterThan(0);
    for (const xml of frags) {
      expect(xml!.match(/xmlns(:\w+)?=/g)!.length, xml).toBeLessThanOrEqual(1);
      expect(parseXml(xml!).documentElement).toBeTruthy(); // still independently parseable
    }
  });
});

describe('resolveRelTarget', () => {
  it('resolves relative, parent and absolute targets against the source part', () => {
    expect(resolveRelTarget('word/document.xml', 'styles.xml')).toBe('word/styles.xml');
    expect(resolveRelTarget('word/document.xml', './media/a.png')).toBe('word/media/a.png');
    expect(resolveRelTarget('word/document.xml', '../customXml/item1.xml')).toBe('customXml/item1.xml');
    expect(resolveRelTarget('word/document.xml', '/word/theme/theme1.xml')).toBe('word/theme/theme1.xml');
    expect(resolveRelTarget('', 'word/document.xml')).toBe('word/document.xml');
    expect(resolveRelTarget('word/document.xml', 'my%20file.xml#frag')).toBe('word/my file.xml');
  });

  it('refuses anything that could leave the package or is not an internal part', () => {
    expect(resolveRelTarget('word/document.xml', '../../etc/passwd')).toBeUndefined();
    expect(resolveRelTarget('word/document.xml', '%2e%2e/%2e%2e/x.xml')).toBeUndefined();
    expect(resolveRelTarget('word/document.xml', '/../x.xml')).toBeUndefined();
    expect(resolveRelTarget('word/document.xml', '..\\..\\x.xml')).toBeUndefined();
    expect(resolveRelTarget('word/document.xml', 'https://example.org/x.xml')).toBeUndefined();
    expect(resolveRelTarget('word/document.xml', 'file:///etc/passwd')).toBeUndefined();
    expect(resolveRelTarget('word/document.xml', '//host/share/x.xml')).toBeUndefined();
    expect(resolveRelTarget('word/document.xml', 'a%00b.xml')).toBeUndefined();
    expect(resolveRelTarget('word/document.xml', '%E0%A4%A')).toBeUndefined();
    expect(resolveRelTarget('word/document.xml', '')).toBeUndefined();
    expect(resolveRelTarget('word/document.xml', '/')).toBeUndefined();
  });
});

describe('readPageSetup', () => {
  const bodyOf = async (name: string) => {
    const pkg = await openPackage(load(name));
    return pkg.xml('word/document.xml')!.getElementsByTagName('w:body')[0];
  };

  it('reads A4 and 2 cm margins from the body sectPr', async () => {
    const { page, extraSections } = readPageSetup(await bodyOf('a4-margins.docx'));
    expect(page.size).toBe('a4');
    expect(page.orientation).toBe('portrait');
    expect(page.marginsIn.left).toBeCloseTo(0.787, 2);
    expect(page.marginsIn.top).toBeCloseTo(0.787, 2);
    expect(extraSections).toBeGreaterThan(0);
  });

  it('uses the body-level sectPr, not the earlier section inside a paragraph', async () => {
    const { page, extraSections } = readPageSetup(await bodyOf('a4-margins.docx'));
    expect(page.size).toBe('a4'); // the paragraph-level sectPr is US Letter
    expect(extraSections).toBe(1);
  });

  it('reads US Letter and reports no extra sections', async () => {
    const pkg = await openPackage(load('minimal.docx'));
    const body = pkg.xml('word/document.xml')!.getElementsByTagName('w:body')[0];
    const { page, extraSections } = readPageSetup(body);
    expect(page.size).toBe('letter');
    expect(extraSections).toBe(0);
  });

  const bodyXml = (inner: string) =>
    parseXml(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${inner}</w:body></w:document>`)
      .getElementsByTagName('w:body')[0];

  it('defaults to US Letter with 1 inch margins when there is no sectPr or pgMar', () => {
    expect(readPageSetup(bodyXml('<w:p/>')).page).toEqual({ size: 'letter', orientation: 'portrait', marginsIn: { top: 1, right: 1, bottom: 1, left: 1 } });
    const { page } = readPageSetup(bodyXml('<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:left="720"/></w:sectPr>'));
    expect(page.marginsIn).toEqual({ top: 1, right: 1, bottom: 1, left: 0.5 });
  });

  it('ignores malformed numbers instead of producing NaN', () => {
    const { page } = readPageSetup(bodyXml('<w:sectPr><w:pgSz w:w="abc" w:h=""/><w:pgMar w:top="x" w:left="-5"/></w:sectPr>'));
    expect(page.size).toBe('letter');
    for (const v of Object.values(page.marginsIn)) expect(Number.isFinite(v) && v >= 0).toBe(true);
  });

  it('maps a nonstandard size to the nearest supported one and says so', () => {
    const report = createReport();
    const { page } = readPageSetup(bodyXml('<w:sectPr><w:pgSz w:w="12240" w:h="16272"/></w:sectPr>'), report); // 8.5 x 11.3 in: nearer Letter than A4
    expect(page.size).toBe('letter');
    expect(report.warnings.some(w => w.feature === 'pageSetup')).toBe(true);
  });

  it('reads landscape as the same paper size and warns that orientation is not kept', () => {
    const report = createReport();
    const { page } = readPageSetup(bodyXml('<w:sectPr><w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/></w:sectPr>'), report);
    expect(page.size).toBe('letter');
    expect(report.warnings.some(w => /landscape/i.test(w.message))).toBe(true);
  });

  it('does not count a paragraph-property-change sectPr as a section', () => {
    const { extraSections } = readPageSetup(
      bodyXml('<w:p><w:pPr><w:pPrChange w:id="1" w:author="a"><w:pPr><w:sectPr/></w:pPr></w:pPrChange></w:pPr></w:p><w:sectPr/>'),
    );
    expect(extraSections).toBe(0);
  });
});
