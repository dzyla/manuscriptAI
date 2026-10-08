/**
 * Calibration against real documents. fixtures/private/ is gitignored and never committed, so on
 * a fresh checkout this suite is skipped. Failures report only part names and error codes, never
 * document content.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { openPackage } from './package';
import { parseXmlStrict } from '../preserve/xml';
import { readStyles } from './styles';
import { readPageSetup } from './pageSetup';
import { mainDocumentPart } from './opc';
import { createReport } from '../fidelity';

const dir = new URL('../../../fixtures/private/', import.meta.url);
const docs = existsSync(dir) ? readdirSync(dir).filter(f => f.toLowerCase().endsWith('.docx')) : [];

describe.skipIf(docs.length === 0)('private real-world documents', () => {
  it.each(docs)('%s: opens, every XML part passes strict parsing, nothing is deferred', async name => {
    const b = readFileSync(new URL(name, dir));
    const pkg = await openPackage(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    const xmlParts = pkg.names().filter(n => /\.(xml|rels)$/i.test(n));
    const failures: string[] = [];
    for (const n of xmlParts) {
      try {
        parseXmlStrict(pkg.entry(n)!);
        pkg.xml(n);
      } catch (e) {
        failures.push(`${n}: ${(e as Error).message.slice(0, 60)}`);
      }
    }
    expect(xmlParts.length).toBeGreaterThan(0);
    expect(failures).toEqual([]);
    expect(pkg.deferred().filter(n => /\.(xml|rels)$/i.test(n))).toEqual([]);
    console.log(`${name}: ${xmlParts.length} XML parts parsed strictly, ${failures.length} threw, ${pkg.names().length} entries, ${pkg.deferred().length} deferred (non-XML)`);
  });

  it.each(docs)('%s: styles and page setup read sanely', async name => {
    const b = readFileSync(new URL(name, dir));
    const pkg = await openPackage(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    const report = createReport();
    const { format, styleIdByWordId, headingLevelByStyleId } = readStyles(pkg, report);
    const body = pkg.xml(mainDocumentPart(pkg))!.getElementsByTagName('w:body')[0];
    const { page, extraSections } = readPageSetup(body, report);

    expect(styleIdByWordId.size).toBeGreaterThan(0);
    expect(format.preset).toBe('custom');
    expect(format.defaults.fontFamily.length).toBeGreaterThan(0);
    expect(format.defaults.fontSizePt).toBeGreaterThanOrEqual(6);
    expect(format.defaults.fontSizePt).toBeLessThanOrEqual(24);
    // Every basedOn / next resolves, and no basedOn chain loops.
    for (const s of Object.values(format.styles)) {
      if (s.basedOn) expect(format.styles[s.basedOn], 'basedOn target missing').toBeDefined();
      if (s.next) expect(format.styles[s.next], 'next target missing').toBeDefined();
      const seen = new Set<string>();
      for (let cur: string | undefined = s.id; cur; cur = format.styles[cur].basedOn) {
        expect(seen.has(cur), 'basedOn loop').toBe(false);
        seen.add(cur);
      }
    }
    expect(headingLevelByStyleId.size).toBeGreaterThan(0);
    expect(page.size === 'letter' || page.size === 'a4').toBe(true);
    for (const m of Object.values(page.marginsIn)) {
      expect(m).toBeGreaterThanOrEqual(0.25);
      expect(m).toBeLessThanOrEqual(2);
    }
    const own = Object.values(format.styles).filter(s => [...styleIdByWordId.values()].includes(s.id));
    const kept = own.filter(s => s.preserved).length;
    console.log(
      `${name}: ${styleIdByWordId.size} styles (${own.filter(s => s.type === 'paragraph').length} paragraph, ${own.filter(s => s.type === 'character').length} character), ` +
        `${[...headingLevelByStyleId.values()].filter(l => l === 1).length}/${[...headingLevelByStyleId.values()].filter(l => l === 2).length}/${[...headingLevelByStyleId.values()].filter(l => l === 3).length} heading styles L1/L2/L3, ` +
        `${kept} carry preserved XML, defaults ${format.defaults.fontSizePt}pt, page ${page.size} margins in T${page.marginsIn.top.toFixed(2)} R${page.marginsIn.right.toFixed(2)} B${page.marginsIn.bottom.toFixed(2)} L${page.marginsIn.left.toFixed(2)}, ` +
        `${extraSections} extra sections, ${report.warnings.length} warnings`,
    );
  });
});
