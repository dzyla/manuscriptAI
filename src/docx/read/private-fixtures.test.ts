/**
 * Calibration against real documents. fixtures/private/ is gitignored and never committed, so on
 * a fresh checkout this suite is skipped. Failures report only part names and error codes, never
 * document content.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { openPackage } from './package';
import { parseXmlStrict } from '../preserve/xml';

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
});
