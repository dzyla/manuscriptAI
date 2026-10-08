import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { isBlockUntouched } from '../preserve/hash';

let failNext = 0;
vi.mock('../../extensions/schemaSpecs', async importOriginal => {
  const actual = await importOriginal<typeof import('../../extensions/schemaSpecs')>();
  return {
    ...actual,
    specNormalizeNode: (n: unknown) => {
      if (failNext > 0) {
        failNext--;
        throw new Error('forced');
      }
      return actual.specNormalizeNode(n as never);
    },
  };
});

const { openPackage } = await import('./package');
const { readStyles } = await import('./styles');
const { readParagraph } = await import('./paragraphs');
const { createReport } = await import('../fidelity');
const { emptyPreservationStore } = await import('../preserve/types');
const { parseXml } = await import('../preserve/xml');
const { W_NS } = await import('./ooxml');

describe('a paragraph that cannot be normalized', () => {
  it('keeps its text but is never stamped as untouched, and stores no block fragment', async () => {
    const b = readFileSync(new URL('../../test/fixtures/docx/minimal.docx', import.meta.url));
    const pkg = await openPackage(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    const report = createReport();
    const preservation = emptyPreservationStore();
    const ctx = { pkg, styles: readStyles(pkg, report), report, preservation, assets: [], nextId: () => 'b1' };
    const p = parseXml(`<w:p xmlns:w="${W_NS}"><w:r><w:rPr><w:b/></w:rPr><w:t>kept text</w:t></w:r></w:p>`).documentElement;
    failNext = 1;
    const node = readParagraph(p, ctx) as { content: { text: string }[]; attrs: Record<string, unknown> };
    expect(node.content[0].text).toBe('kept text');
    expect(node.attrs.ooxml).toBeNull();
    expect(isBlockUntouched(node as never)).toBe(false);
    expect(Object.keys(preservation.blocks)).toEqual([]);
    expect(report.warnings.some(w => /could not be represented/.test(w.message))).toBe(true);
  });

  it('withdraws the fragments and counts of the atoms it discards, so nothing is orphaned or over-counted', async () => {
    const b = readFileSync(new URL('../../test/fixtures/docx/minimal.docx', import.meta.url));
    const pkg = await openPackage(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    const report = createReport();
    const preservation = emptyPreservationStore();
    let n = 0;
    const ctx = { pkg, styles: readStyles(pkg, report), report, preservation, assets: [], nextId: () => `id${++n}` };
    const keep = parseXml(`<w:p xmlns:w="${W_NS}"><w:r><w:t>fine</w:t></w:r><w:ins w:id="1"><w:r><w:t>kept</w:t></w:r></w:ins></w:p>`).documentElement;
    const lose = parseXml(
      `<w:p xmlns:w="${W_NS}"><w:r><w:t>lost atoms</w:t></w:r><w:ins w:id="2"><w:r><w:t>x</w:t></w:r></w:ins><w:commentRangeStart w:id="9"/></w:p>`,
    ).documentElement;
    readParagraph(keep, ctx);
    const keptFragments = Object.keys(preservation.fragments);
    failNext = 1;
    const node = readParagraph(lose, ctx) as { content: { type: string; text?: string }[] };
    expect(node.content).toEqual([{ type: 'text', text: 'lost atoms' }]);
    expect(Object.keys(preservation.fragments)).toEqual(keptFragments);
    expect(report.counts.trackedChange).toBe(1);
    expect(report.counts.comment).toBeUndefined();
    expect(report.byCategory[3]).toBe(1);
    expect(report.warnings.find(w => /could not be represented/.test(w.message))!.message).toMatch(/Tracked changes, comments/);
  });

  it('does not leave a comment uncounted because its first anchor was in a discarded paragraph', async () => {
    const b = readFileSync(new URL('../../test/fixtures/docx/minimal.docx', import.meta.url));
    const pkg = await openPackage(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    const report = createReport();
    let n = 0;
    const ctx = { pkg, styles: readStyles(pkg, report), report, preservation: emptyPreservationStore(), assets: [], nextId: () => `id${++n}` };
    const first = parseXml(`<w:p xmlns:w="${W_NS}"><w:commentRangeStart w:id="7"/><w:r><w:t>a</w:t></w:r></w:p>`).documentElement;
    const second = parseXml(`<w:p xmlns:w="${W_NS}"><w:r><w:t>b</w:t></w:r><w:commentRangeEnd w:id="7"/></w:p>`).documentElement;
    failNext = 1;
    readParagraph(first, ctx);
    readParagraph(second, ctx);
    expect(report.counts.comment).toBe(1);
  });
});
