import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { openPackage, DocxOpenError, DEFAULT_LIMITS } from './package';

const load = (name: string): ArrayBuffer => {
  const b = readFileSync(new URL(`../../test/fixtures/docx/${name}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe('openPackage', () => {
  it('exposes parts, relationships and content types', async () => {
    const pkg = await openPackage(load('minimal.docx'));
    expect(pkg.names()).toContain('word/document.xml');
    expect(pkg.xml('word/document.xml')?.documentElement.localName).toBe('document');
    expect(pkg.contentType('word/document.xml')).toMatch(/wordprocessingml\.document\.main/);
    expect(pkg.original.byteLength).toBeGreaterThan(0);
  });

  it('returns undefined for a part that is absent, not a throw', async () => {
    const pkg = await openPackage(load('minimal.docx'));
    expect(pkg.xml('word/footnotes.xml')).toBeUndefined();
    expect(pkg.bytes('word/media/image9.png')).toBeUndefined();
    expect(pkg.entry('word/footnotes.xml')).toBeUndefined();
    expect(pkg.rels('word/footnotes.xml').size).toBe(0);
    expect(pkg.contentType('word/nothing.bin')).toBeUndefined();
  });

  it('rejects a macro-enabled package', async () => {
    await expect(openPackage(load('macro.docm'))).rejects.toMatchObject({ code: 'macro' });
  });

  it('rejects a zip bomb before inflating it', async () => {
    await expect(openPackage(load('bomb.docx'), { maxRatio: 100 })).rejects.toMatchObject({ code: 'bomb' });
  });

  it('rejects path traversal', async () => {
    await expect(openPackage(load('traversal.docx'))).rejects.toMatchObject({ code: 'bad-path' });
  });

  it('rejects something that is not a docx', async () => {
    await expect(openPackage(new TextEncoder().encode('not a zip').buffer as ArrayBuffer)).rejects.toBeInstanceOf(DocxOpenError);
  });

  it('reports corrupt XML as corrupt, not as a crash', async () => {
    const pkg = await openPackage(load('truncated.docx'));
    expect(() => pkg.xml('word/document.xml')).toThrowError(DocxOpenError);
  });

  it('enforces the entry-count and size limits', async () => {
    await expect(openPackage(load('minimal.docx'), { maxEntries: 1 })).rejects.toMatchObject({ code: 'too-many-entries' });
    await expect(openPackage(load('minimal.docx'), { maxCompressedBytes: 10 })).rejects.toMatchObject({ code: 'too-large' });
  });

  it('records external relationships without fetching them', async () => {
    const pkg = await openPackage(load('minimal.docx'));
    const rels = pkg.rels('word/document.xml');
    expect(rels).toBeInstanceOf(Map);
    for (const rel of rels.values()) {
      if (rel.targetMode === 'External') expect(rel.target).toMatch(/^https?:|^mailto:|^file:/);
    }
  });

  it('defaults match the spec', () => {
    expect(DEFAULT_LIMITS).toEqual({ maxCompressedBytes: 50e6, maxUncompressedBytes: 300e6, maxEntries: 2000, maxRatio: 100 });
  });
});

describe('openPackage: hardening beyond the happy path', () => {
  it('actually records the external hyperlink and never touches the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const pkg = await openPackage(load('minimal.docx'));
      const rels = pkg.rels('word/document.xml');
      const external = [...rels.values()].filter(r => r.targetMode === 'External');
      expect(external).toEqual([
        expect.objectContaining({ id: 'rId2', target: 'https://example.org/paper', targetMode: 'External' }),
      ]);
      expect(rels.get('rId1')).toMatchObject({ target: 'styles.xml' });
      expect(rels.get('rId1')?.targetMode).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reads package-level relationships from _rels/.rels', async () => {
    const pkg = await openPackage(load('minimal.docx'));
    expect(pkg.rels('').get('rId1')).toMatchObject({ target: 'word/document.xml' });
  });

  it('rejects an entry whose real inflated size exceeds what the central directory declares', async () => {
    // The central directory claims 1 MB (ratio ~50:1, so the ratio guard passes) but the stream is 20 MB.
    await expect(openPackage(load('lying-size.docx'))).rejects.toMatchObject({ code: 'bomb' });
  });

  it('rejects when declared uncompressed sizes sum past the total limit, before inflating', async () => {
    await expect(openPackage(load('minimal.docx'), { maxUncompressedBytes: 100 })).rejects.toMatchObject({ code: 'too-large' });
  });

  it('does not inflate any entry once a declared-size check fails', async () => {
    // bomb.docx fails on the ratio check; the 20 MB entry must never be materialised.
    const before = process.memoryUsage().arrayBuffers;
    await expect(openPackage(load('bomb.docx'))).rejects.toMatchObject({ code: 'bomb' });
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(10_000_000);
  });

  it('rejects duplicate part names (zip-confusion guard)', async () => {
    await expect(openPackage(load('duplicate.docx'))).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('rejects absolute, drive-letter, backslash-traversal and NUL names', async () => {
    const mk = async (name: string) => {
      const zip = new JSZip();
      zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
      zip.file(name, 'x', { createFolders: false });
      return zip.generateAsync({ type: 'arraybuffer' });
    };
    for (const name of ['/abs.xml', 'C:/win.xml', 'word\\..\\..\\up.xml', 'word/../../up.xml', 'a\0b.xml']) {
      await expect(openPackage(await mk(name)), name).rejects.toMatchObject({ code: 'bad-path' });
    }
  });

  it('rejects a package that has no [Content_Types].xml', async () => {
    const zip = new JSZip();
    zip.file('hello.txt', 'hi');
    await expect(openPackage(await zip.generateAsync({ type: 'arraybuffer' }))).rejects.toMatchObject({ code: 'not-docx' });
  });

  it('rejects vbaProject.bin even if the content type claims a plain document', async () => {
    const src = await JSZip.loadAsync(load('minimal.docx'));
    src.file('word/VBAProject.bin', new Uint8Array([1, 2, 3]), { createFolders: false });
    await expect(openPackage(await src.generateAsync({ type: 'arraybuffer' }))).rejects.toMatchObject({ code: 'macro' });
  });

  it('rejects a macro-enabled main content type even with no vbaProject.bin part', async () => {
    const src = await JSZip.loadAsync(load('minimal.docx'));
    const ct = (await src.file('[Content_Types].xml')!.async('string')).replace(
      'wordprocessingml.document.main+xml',
      'ms-word.document.macroEnabled.main+xml',
    );
    src.file('[Content_Types].xml', ct, { createFolders: false });
    await expect(openPackage(await src.generateAsync({ type: 'arraybuffer' }))).rejects.toMatchObject({ code: 'macro' });
  });

  it('refuses XML that declares a DTD or entities', async () => {
    const src = await JSZip.loadAsync(load('minimal.docx'));
    src.file(
      'word/document.xml',
      '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x "boom">]><d xmlns="urn:x">&x;</d>',
      { createFolders: false },
    );
    const pkg = await openPackage(await src.generateAsync({ type: 'arraybuffer' }));
    expect(() => pkg.xml('word/document.xml')).toThrowError(DocxOpenError);
  });

  it('caches parsed parts and decodes text without a BOM', async () => {
    const pkg = await openPackage(load('minimal.docx'));
    expect(pkg.xml('word/document.xml')).toBe(pkg.xml('word/document.xml'));
    expect(pkg.entry('word/document.xml')?.startsWith('<?xml')).toBe(true);
    expect(pkg.bytes('word/document.xml')).toBeInstanceOf(Uint8Array);
  });
});
