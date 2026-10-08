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

/** Names of the entries JSZip was asked to inflate while `run` executes. */
async function spyInflations(sample: ArrayBuffer, run: () => Promise<unknown>): Promise<string[]> {
  const probe = await JSZip.loadAsync(sample);
  const proto = Object.getPrototypeOf(Object.values(probe.files).find(f => !f.dir)!);
  const orig = proto.internalStream;
  const names: string[] = [];
  proto.internalStream = function (this: { name: string }, ...args: unknown[]) {
    names.push(this.name);
    return orig.apply(this, args);
  };
  try {
    await run();
  } finally {
    proto.internalStream = orig;
  }
  return names;
}

/** Rewrite the declared uncompressed size of one entry in the central directory. */
function declareUncompressed(buf: Uint8Array, entry: string, size: number): void {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let pos = 0; pos + 46 <= buf.length; pos++) {
    if (dv.getUint32(pos, true) !== 0x02014b50) continue;
    const nameLen = dv.getUint16(pos + 28, true);
    if (new TextDecoder().decode(buf.subarray(pos + 46, pos + 46 + nameLen)) === entry) {
      dv.setUint32(pos + 24, size, true);
      return;
    }
  }
  throw new Error(`no central directory record for ${entry}`);
}

async function minimalWith(extra: (zip: JSZip) => void): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(load('minimal.docx'));
  extra(zip);
  return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
}

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

  it('catches the same lie on a deferred (non-XML) part when it is finally read', async () => {
    const zip = await JSZip.loadAsync(load('minimal.docx'));
    zip.file('word/media/liar.bin', new Uint8Array(20_000_000).fill(0x41), { createFolders: false, compression: 'DEFLATE' });
    const buf = new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
    declareUncompressed(buf, 'word/media/liar.bin', 1_000_000);
    const pkg = await openPackage(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    expect(pkg.deferred()).toEqual(['word/media/liar.bin']);
    await expect(pkg.bytesAsync('word/media/liar.bin')).rejects.toMatchObject({ code: 'bomb' });
  });

  it('rejects when declared uncompressed sizes sum past the total limit, before inflating', async () => {
    await expect(openPackage(load('minimal.docx'), { maxUncompressedBytes: 100 })).rejects.toMatchObject({ code: 'too-large' });
  });

  it('does not inflate any entry once a declared-size check fails', async () => {
    // bomb.docx fails on the ratio check; its 20 MB entry must never be streamed.
    const calls = await spyInflations(load('bomb.docx'), () =>
      expect(openPackage(load('bomb.docx'))).rejects.toMatchObject({ code: 'bomb' }),
    );
    expect(calls).toEqual([]);
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

describe('openPackage: alias entries (JSZip collapses ., empty and .. segments)', () => {
  it.each(['alias.docx', 'alias-empty-segment.docx'])('rejects %s instead of letting the alias replace word/document.xml', async name => {
    await expect(openPackage(load(name))).rejects.toMatchObject({ code: 'bad-path' });
  });

  it('rejects every spelling of a dot or empty segment, including over [Content_Types].xml', async () => {
    const names = ['./word/document.xml', 'word//document.xml', 'word/./document.xml', './/word/document.xml', './[Content_Types].xml', 'word/x/../document.xml'];
    for (const name of names) {
      const buf = await minimalWith(zip => zip.file(name, '<x/>', { createFolders: false }));
      await expect(openPackage(buf), name).rejects.toMatchObject({ code: 'bad-path' });
    }
  });
});

describe('openPackage: part names are case-insensitive', () => {
  it('resolves a part whatever the case of the request', async () => {
    const pkg = await openPackage(load('minimal.docx'));
    expect(pkg.bytes('WORD/STYLES.XML')).toBeInstanceOf(Uint8Array);
    expect(pkg.xml('/Word/Document.xml')?.documentElement.localName).toBe('document');
    expect(pkg.rels('WORD/DOCUMENT.XML').size).toBeGreaterThan(0);
    expect(pkg.contentType('WORD/DOCUMENT.XML')).toMatch(/document\.main/);
  });

  it('finds [Content_Types].xml whatever case the producer wrote', async () => {
    const zip = await JSZip.loadAsync(load('minimal.docx'));
    const ct = await zip.file('[Content_Types].xml')!.async('string');
    zip.remove('[Content_Types].xml');
    zip.file('[content_types].XML', ct, { createFolders: false });
    const pkg = await openPackage(await zip.generateAsync({ type: 'arraybuffer' }));
    expect(pkg.contentType('word/document.xml')).toMatch(/document\.main/);
  });
});

describe('openPackage: eager budget and deferred parts', () => {
  it('serves every XML part of an ordinary document on the sync path, nothing deferred', async () => {
    const pkg = await openPackage(load('minimal.docx'));
    expect(pkg.deferred()).toEqual([]);
  });

  it('defers non-XML parts: sync accessors throw, async accessors read them', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const buf = await minimalWith(zip => zip.file('word/media/image1.png', png, { createFolders: false }));
    const pkg = await openPackage(buf);
    expect(pkg.names()).toContain('word/media/image1.png');
    expect(pkg.deferred()).toEqual(['word/media/image1.png']);
    expect(() => pkg.bytes('word/media/image1.png')).toThrowError(expect.objectContaining({ code: 'too-large' }));
    expect(Array.from((await pkg.bytesAsync('WORD/media/image1.png'))!)).toEqual(Array.from(png));
    expect(await pkg.bytesAsync('word/media/missing.png')).toBeUndefined();
  });

  it('defers an XML part that does not fit the eager budget: sync accessors THROW (never read as absent), async accessors serve it', async () => {
    const pkg = await openPackage(load('minimal.docx'), { maxEagerBytes: 700 });
    const deferred = pkg.deferred();
    expect(deferred.length).toBeGreaterThan(0);
    const name = deferred[0];
    const tooLarge = expect.objectContaining({ code: 'too-large' });
    expect(() => pkg.xml(name)).toThrowError(tooLarge);
    expect(() => pkg.entry(name)).toThrowError(tooLarge);
    expect(() => pkg.bytes(name)).toThrowError(tooLarge);
    expect(pkg.xml('word/not-a-part.xml')).toBeUndefined(); // genuinely absent still reads as absent
    expect((await pkg.entryAsync(name))!.length).toBeGreaterThan(0);
    const doc = await pkg.xmlAsync(name);
    expect(doc).toBeDefined();
    expect(await pkg.xmlAsync(name)).toBe(doc); // cached, not re-inflated and re-parsed
    expect(pkg.names()).toContain(name);
  });

  it('refuses to read a deferred .rels part as empty', async () => {
    const pkg = await openPackage(load('minimal.docx'), { maxEagerBytes: 1 });
    expect(pkg.deferred()).toContain('word/_rels/document.xml.rels');
    expect(() => pkg.rels('word/document.xml')).toThrowError(expect.objectContaining({ code: 'too-large' }));
  });

  it('does not allocate for a media part that declares 299 MB at the 100:1 ratio edge', async () => {
    // ~3 MB of stored (incompressible) bytes whose header claims 299 MB: it passes every
    // declared-size check, and must never be inflated by openPackage.
    const noise = new Uint8Array(3_000_000);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
    const zip = await JSZip.loadAsync(load('minimal.docx'));
    zip.file('word/media/x.bin', noise, { createFolders: false, compression: 'STORE' });
    const buf = new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
    declareUncompressed(buf, 'word/media/x.bin', 299_000_000);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    let pkg;
    const calls = await spyInflations(ab, async () => {
      pkg = await openPackage(ab);
    });
    expect(calls).not.toContain('word/media/x.bin');
    expect(pkg!.deferred()).toEqual(['word/media/x.bin']);
    // Asking for it is refused up front by maxPartBytes: no 299 MB buffer is ever allocated.
    const asyncCalls = await spyInflations(ab, () =>
      expect(pkg!.bytesAsync('word/media/x.bin')).rejects.toMatchObject({ code: 'too-large' }),
    );
    expect(asyncCalls).toEqual([]);
  });

  it('bounds an on-demand read by maxPartBytes before allocating, and the cap is overridable', async () => {
    const png = new Uint8Array(5000).map((_, i) => (i * 31) & 255);
    const buf = await minimalWith(zip => zip.file('word/media/m.png', png, { createFolders: false }));
    const small = await openPackage(buf, { maxPartBytes: 1000 });
    await expect(small.bytesAsync('word/media/m.png')).rejects.toMatchObject({ code: 'too-large' });
    await expect(small.entryAsync('word/media/m.png')).rejects.toMatchObject({ code: 'too-large' });
    const roomy = await openPackage(buf, { maxPartBytes: 10_000 });
    expect((await roomy.bytesAsync('word/media/m.png'))!.length).toBe(5000);
  });
});

describe('openPackage: API contracts', () => {
  it('DEFAULT_LIMITS cannot be edited in place', () => {
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
    expect(() => {
      (DEFAULT_LIMITS as any).maxRatio = 1e9;
    }).toThrow();
    expect(DEFAULT_LIMITS.maxRatio).toBe(100);
  });

  it('rels() throws corrupt for a malformed or empty .rels part, and returns empty when there is none', async () => {
    const empty = await minimalWith(zip => zip.file('word/_rels/document.xml.rels', '', { createFolders: false }));
    const pkg = await openPackage(empty);
    expect(() => pkg.rels('word/document.xml')).toThrowError(expect.objectContaining({ code: 'corrupt' }));
    expect((await openPackage(load('minimal.docx'))).rels('word/styles.xml').size).toBe(0);
  });
});

describe('openPackage: local-header name divergence (JSZip trusts the local header)', () => {
  it('refuses a case-variant alias whose local-header name differs from its central name', async () => {
    // Central name zzzz/document.xml, local name word/DOCUMENT.xml. Previously opened, and
    // entry("WORD/Document.xml") returned the attacker's part.
    await expect(openPackage(load('local-name-case-alias.docx'))).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('refuses a [Content_Types].xml decoy that would hide a macro-enabled real one', async () => {
    // Previously opened with the benign decoy's content types, bypassing the macro refusal. It is now
    // refused at the name check, before anything is inflated (so the code is corrupt, not macro).
    const calls = await spyInflations(load('content-types-decoy.docx'), () =>
      expect(openPackage(load('content-types-decoy.docx'))).rejects.toMatchObject({ code: 'corrupt' }),
    );
    expect(calls).toEqual([]);
  });

  it('still refuses the same macro-enabled content type as macro when there is no decoy', async () => {
    await expect(openPackage(load('macro-content-type.docx'))).rejects.toMatchObject({ code: 'macro' });
  });
});

describe('openPackage: round 3', () => {
  it('refuses records whose local-header names are swapped (same name set, wrong owner)', async () => {
    // Before: opened, and entry("word/document.xml") returned the other record's bytes while Word
    // (reading central names) sees the opposite.
    await expect(openPackage(load('swapped-local-names.docx'))).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('caps [Content_Types].xml before inflating it', async () => {
    // ~3 MB stored, header claims 299 MB (ratio ~99.7, so only the dedicated cap catches it).
    const noise = new Uint8Array(3_000_000);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
    const zip = await JSZip.loadAsync(load('minimal.docx'));
    zip.file('[Content_Types].xml', noise, { createFolders: false, compression: 'STORE' });
    const buf = new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
    declareUncompressed(buf, '[Content_Types].xml', 299_000_000);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const calls = await spyInflations(ab, () => expect(openPackage(ab)).rejects.toMatchObject({ code: 'too-large' }));
    expect(calls).toEqual([]);
  });

  it('isDeferred distinguishes deferred from absent and eager, case-insensitively', async () => {
    const buf = await minimalWith(zip => zip.file('word/media/image1.png', new Uint8Array([1, 2, 3]), { createFolders: false }));
    const pkg = await openPackage(buf);
    expect(pkg.isDeferred('word/media/image1.png')).toBe(true);
    expect(pkg.isDeferred('/WORD/Media/IMAGE1.PNG')).toBe(true);
    expect(pkg.isDeferred('word/media/missing.png')).toBe(false);
    expect(pkg.isDeferred('word/document.xml')).toBe(false);
    const tight = await openPackage(load('minimal.docx'), { maxEagerBytes: 700 });
    expect(tight.deferred().length).toBeGreaterThan(0);
    for (const n of tight.deferred()) expect(tight.isDeferred(n.toUpperCase())).toBe(true);
  });
});

describe('openPackage: the parsed-DOM cache is bounded', () => {
  it('reuses a parsed document while it fits the budget', async () => {
    const pkg = await openPackage(load('minimal.docx'));
    expect(pkg.xml('word/document.xml')).toBe(pkg.xml('word/document.xml'));
  });

  it('never caches when the budget is 0, so memory cannot accumulate', async () => {
    const pkg = await openPackage(load('minimal.docx'), { maxCachedXmlBytes: 0 });
    const a = pkg.xml('word/document.xml');
    expect(a).toBeDefined();
    expect(pkg.xml('word/document.xml')).not.toBe(a);
  });

  it('evicts the least recently used document once the budget is exceeded', async () => {
    const pkg0 = await openPackage(load('minimal.docx'));
    const docLen = pkg0.bytes('word/document.xml')!.length;
    const stylesLen = pkg0.bytes('word/styles.xml')!.length;
    // Room for the larger of the two but not both.
    const pkg = await openPackage(load('minimal.docx'), { maxCachedXmlBytes: Math.max(docLen, stylesLen) + 1 });
    const doc1 = pkg.xml('word/document.xml');
    const styles1 = pkg.xml('word/styles.xml');
    expect(styles1).toBe(pkg.xml('word/styles.xml')); // most recent survives
    expect(pkg.xml('word/document.xml')).not.toBe(doc1); // oldest was evicted and re-parsed
  });

  it('releaseXml drops a parsed document on request', async () => {
    const pkg = await openPackage(load('minimal.docx'));
    const a = pkg.xml('word/document.xml');
    pkg.releaseXml('WORD/document.xml');
    expect(pkg.xml('word/document.xml')).not.toBe(a);
    expect(() => pkg.releaseXml('word/missing.xml')).not.toThrow();
  });
});
