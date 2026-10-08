/**
 * OPC/.docx package reader. This is the security boundary for user-supplied files: every limit
 * below is enforced from the zip central directory BEFORE any entry is inflated, and inflation
 * itself is bounded so a header that lies about an entry's size cannot exhaust memory either.
 *
 * Pure and worker-safe: no React, no DOM globals, XML via @xmldom/xmldom only. Nothing in a
 * package is ever fetched; external relationships are only recorded.
 */
import JSZip from 'jszip';
import { parseXmlStrict } from '../preserve/xml';
import type { PackageRel } from '../preserve/types';

export interface PackageLimits {
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
  maxEntries: number;
  /** Per-entry uncompressed:compressed ratio. */
  maxRatio: number;
}

export const DEFAULT_LIMITS: PackageLimits = {
  maxCompressedBytes: 50e6,
  maxUncompressedBytes: 300e6,
  maxEntries: 2000,
  maxRatio: 100,
};

export type DocxOpenErrorCode =
  | 'macro'
  | 'too-large'
  | 'too-many-entries'
  | 'bomb'
  | 'bad-path'
  | 'not-docx'
  | 'corrupt';

export class DocxOpenError extends Error {
  readonly code: DocxOpenErrorCode;
  constructor(code: DocxOpenErrorCode, message: string) {
    super(message);
    this.name = 'DocxOpenError';
    this.code = code;
  }
}

export interface DocxPackage {
  /** Part as UTF-8 text, or undefined when the package has no such part. */
  entry(path: string): string | undefined;
  /** Raw part bytes (shared, do not mutate), or undefined when absent. */
  bytes(path: string): Uint8Array | undefined;
  /** Part parsed as XML (cached, treat as read-only); undefined when absent; throws DocxOpenError('corrupt') when malformed. */
  xml(path: string): Document | undefined;
  /** Relationships of a part (`''` for the package itself), keyed by Id. Empty when it has none. */
  rels(partPath: string): Map<string, PackageRel>;
  contentType(path: string): string | undefined;
  names(): string[];
  /** The untouched input, kept so A2b can re-emit parts it does not model. */
  original: ArrayBuffer;
}

const CONTENT_TYPES = '[Content_Types].xml';
const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const MAX_XML_DEPTH = 256;
const MACRO_NAME = /(^|\/)vbaproject(signature)?\.bin$/i;
const MACRO_TYPE = /macroEnabled|vbaProject|vbaData/i;

/** Reject absolute paths, drive letters, NULs and any `..` segment (after `\` -> `/`). */
function checkEntryName(raw: string): void {
  const name = raw.replace(/\\/g, '/');
  if (
    name === '' ||
    name.startsWith('/') ||
    /^[a-zA-Z]:/.test(name) ||
    name.includes('\0') ||
    name.split('/').includes('..')
  ) {
    throw new DocxOpenError('bad-path', `unsafe entry name in package: ${JSON.stringify(raw.slice(0, 120))}`);
  }
}

/**
 * Walk the raw central directory (names and counts only) before JSZip builds an object per
 * record, so a file claiming a million empty entries is rejected without allocating them.
 * It also catches duplicate names, which different consumers would resolve differently.
 */
function scanCentralDirectory(data: ArrayBuffer, limits: PackageLimits): void {
  const u8 = new Uint8Array(data);
  const dv = new DataView(data);
  if (u8.length < 22) throw new DocxOpenError('not-docx', 'not a zip archive');
  let eocd = -1;
  for (let i = u8.length - 22, stop = Math.max(0, u8.length - 22 - 0xffff); i >= stop; i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new DocxOpenError('not-docx', 'not a zip archive (no end-of-central-directory record)');
  const declared = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (declared > limits.maxEntries) {
    throw new DocxOpenError('too-many-entries', `package declares ${declared} entries (limit ${limits.maxEntries})`);
  }
  if (declared === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new DocxOpenError('too-large', 'zip64 packages are not supported');
  }
  // Tolerate bytes prepended to the archive, as JSZip does.
  const at = (p: number) => p >= 0 && p + 46 <= u8.length && dv.getUint32(p, true) === SIG_CENTRAL;
  let pos = [eocd - cdSize, cdOffset].find(at) ?? -1;
  if (pos < 0) throw new DocxOpenError('corrupt', 'zip central directory not found');

  const seen = new Set<string>();
  const decoder = new TextDecoder('utf-8');
  let count = 0;
  while (at(pos)) {
    // Count by walking records, not by the (forgeable) header total.
    if (++count > limits.maxEntries) {
      throw new DocxOpenError('too-many-entries', `package has more than ${limits.maxEntries} entries`);
    }
    const nameLen = dv.getUint16(pos + 28, true);
    const extraLen = dv.getUint16(pos + 30, true);
    const commentLen = dv.getUint16(pos + 32, true);
    if (pos + 46 + nameLen > u8.length) throw new DocxOpenError('corrupt', 'truncated zip central directory');
    const name = decoder.decode(u8.subarray(pos + 46, pos + 46 + nameLen));
    checkEntryName(name);
    const key = name.replace(/\\/g, '/').toLowerCase(); // OPC part names are case-insensitive
    if (seen.has(key)) throw new DocxOpenError('corrupt', `duplicate entry name: ${JSON.stringify(name.slice(0, 120))}`);
    seen.add(key);
    pos += 46 + nameLen + extraLen + commentLen;
  }
}

interface SizeInfo {
  compressed: number;
  uncompressed: number;
}

/**
 * Declared sizes come from JSZip's per-entry CompressedObject (`_data`), which JSZip fills from
 * the central directory without inflating anything. Verified present in jszip 3.10.1; if a
 * future version drops it this returns undefined and the caller falls back to bounded inflation
 * against the remaining total budget.
 */
function declaredSize(file: JSZip.JSZipObject): SizeInfo | undefined {
  const d = (file as any)._data;
  if (d && Number.isFinite(d.uncompressedSize) && Number.isFinite(d.compressedSize) && d.uncompressedSize >= 0 && d.compressedSize >= 0) {
    return { compressed: d.compressedSize, uncompressed: d.uncompressedSize };
  }
  return undefined;
}

/**
 * Inflate one entry, never holding or writing more than `limit` bytes. With `exact` (the declared
 * size) the result must match it. Overshoot is bounded by what one 16 KB compressed input chunk
 * can expand to, and those bytes are discarded rather than stored.
 */
function inflateEntry(file: JSZip.JSZipObject, name: string, limit: number, exact: number | undefined): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    let helper: any;
    try {
      helper = (file as any).internalStream('uint8array');
    } catch (e) {
      reject(new DocxOpenError('corrupt', `cannot read entry ${name}: ${(e as Error).message}`));
      return;
    }
    const fixed = exact !== undefined ? new Uint8Array(exact) : undefined;
    const chunks: Uint8Array[] = [];
    let len = 0;
    let settled = false;
    const fail = (err: DocxOpenError) => {
      if (settled) return;
      settled = true;
      try {
        helper.pause();
      } catch {
        /* already finished */
      }
      reject(err);
    };
    helper
      .on('data', (chunk: Uint8Array) => {
        if (settled) return;
        if (len + chunk.length > limit) {
          fail(
            exact !== undefined
              ? new DocxOpenError('bomb', `entry ${name} inflates beyond its declared size`)
              : new DocxOpenError('too-large', `entry ${name} exceeds the uncompressed size limit`),
          );
          return;
        }
        if (fixed) fixed.set(chunk, len);
        else chunks.push(chunk.slice());
        len += chunk.length;
      })
      .on('error', (e: Error) => fail(new DocxOpenError('corrupt', `cannot inflate entry ${name}: ${e.message}`)))
      .on('end', () => {
        if (settled) return;
        settled = true;
        if (fixed) {
          if (len !== exact) {
            reject(new DocxOpenError('corrupt', `entry ${name} is shorter than its declared size`));
          } else resolve(fixed);
          return;
        }
        const out = new Uint8Array(len);
        let o = 0;
        for (const c of chunks) {
          out.set(c, o);
          o += c.length;
        }
        resolve(out);
      })
      .resume();
  });
}

/** Iterative depth check, so a deeply nested part cannot overflow the stack of later recursive walkers. */
function assertShallow(doc: Document, name: string): void {
  const stack: Array<[Node, number]> = [[doc.documentElement, 1]];
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (depth > MAX_XML_DEPTH) throw new DocxOpenError('corrupt', `${name} is nested deeper than ${MAX_XML_DEPTH} levels`);
    for (let c = node.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) stack.push([c, depth + 1]);
  }
}

class Package implements DocxPackage {
  private readonly parts: Map<string, Uint8Array>;
  /** lowercased part name -> real name (OPC part names are case-insensitive) */
  private readonly index = new Map<string, string>();
  private readonly docs = new Map<string, Document>();
  private readonly relCache = new Map<string, Map<string, PackageRel>>();
  private types?: { defaults: Map<string, string>; overrides: Map<string, string> };

  constructor(parts: Map<string, Uint8Array>, readonly original: ArrayBuffer) {
    this.parts = parts;
    for (const name of parts.keys()) this.index.set(name.toLowerCase(), name);
  }

  private resolve(path: string): string | undefined {
    const p = path.replace(/^\/+/, '');
    if (this.parts.has(p)) return p;
    return this.index.get(p.toLowerCase());
  }

  names(): string[] {
    return [...this.parts.keys()];
  }

  bytes(path: string): Uint8Array | undefined {
    const name = this.resolve(path);
    return name === undefined ? undefined : this.parts.get(name);
  }

  entry(path: string): string | undefined {
    const b = this.bytes(path);
    // TextDecoder strips a UTF-8 BOM and substitutes U+FFFD for invalid sequences.
    return b === undefined ? undefined : new TextDecoder('utf-8').decode(b);
  }

  xml(path: string): Document | undefined {
    const name = this.resolve(path);
    if (name === undefined) return undefined;
    const cached = this.docs.get(name);
    if (cached) return cached;
    let doc: Document;
    try {
      doc = parseXmlStrict(this.entry(name)!);
    } catch (e) {
      throw new DocxOpenError('corrupt', `${name} is not well-formed XML: ${(e as Error).message}`);
    }
    assertShallow(doc, name);
    this.docs.set(name, doc);
    return doc;
  }

  rels(partPath: string): Map<string, PackageRel> {
    const slash = partPath.lastIndexOf('/');
    const relsPath = `${partPath.slice(0, slash + 1)}_rels/${partPath.slice(slash + 1)}.rels`;
    const hit = this.relCache.get(relsPath);
    if (hit) return hit;
    const out = new Map<string, PackageRel>();
    const doc = this.xml(relsPath);
    if (doc) {
      const els = doc.documentElement.getElementsByTagName('*');
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        if (el.localName !== 'Relationship') continue;
        const id = el.getAttribute('Id');
        const target = el.getAttribute('Target');
        if (!id || target === null || out.has(id)) continue;
        const rel: PackageRel = { id, type: el.getAttribute('Type') ?? '', target };
        if ((el.getAttribute('TargetMode') ?? '').toLowerCase() === 'external') rel.targetMode = 'External';
        out.set(id, rel);
      }
    }
    this.relCache.set(relsPath, out);
    return out;
  }

  private loadTypes() {
    if (this.types) return this.types;
    const defaults = new Map<string, string>();
    const overrides = new Map<string, string>();
    const doc = this.xml(CONTENT_TYPES);
    if (doc) {
      const els = doc.documentElement.getElementsByTagName('*');
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        const type = el.getAttribute('ContentType');
        if (!type) continue;
        if (el.localName === 'Default') {
          const ext = el.getAttribute('Extension');
          if (ext) defaults.set(ext.toLowerCase(), type);
        } else if (el.localName === 'Override') {
          const part = el.getAttribute('PartName');
          if (part) overrides.set(part.replace(/^\/+/, '').toLowerCase(), type);
        }
      }
    }
    return (this.types = { defaults, overrides });
  }

  /** Every content type the package declares, for the macro check. */
  declaredContentTypes(): string[] {
    const t = this.loadTypes();
    return [...t.overrides.values(), ...t.defaults.values()];
  }

  contentType(path: string): string | undefined {
    const p = path.replace(/^\/+/, '');
    const t = this.loadTypes();
    const override = t.overrides.get(p.toLowerCase());
    if (override) return override;
    const dot = p.lastIndexOf('.');
    return dot < 0 ? undefined : t.defaults.get(p.slice(dot + 1).toLowerCase());
  }
}

export async function openPackage(data: ArrayBuffer, limits: Partial<PackageLimits> = {}): Promise<DocxPackage> {
  const lim: PackageLimits = { ...DEFAULT_LIMITS, ...limits };

  // 1. Cheap checks on the raw bytes: no zip object has been built yet.
  if (!data || typeof data.byteLength !== 'number') throw new DocxOpenError('not-docx', 'no data');
  if (data.byteLength > lim.maxCompressedBytes) {
    throw new DocxOpenError('too-large', `file is ${data.byteLength} bytes (limit ${lim.maxCompressedBytes})`);
  }
  scanCentralDirectory(data, lim);

  // 2. Read the directory only. loadAsync parses headers; it does not inflate entry data.
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch (e) {
    throw new DocxOpenError('not-docx', `not a readable zip archive: ${(e as Error).message}`);
  }
  const files = Object.values(zip.files);
  if (files.length > lim.maxEntries) {
    throw new DocxOpenError('too-many-entries', `package has ${files.length} entries (limit ${lim.maxEntries})`);
  }
  // JSZip normalises names (e.g. "../x" -> "x") and keeps the original; vet both.
  for (const f of files) {
    checkEntryName(f.name);
    if (f.unsafeOriginalName !== undefined) checkEntryName(f.unsafeOriginalName);
    if (MACRO_NAME.test(f.name.replace(/\\/g, '/'))) throw new DocxOpenError('macro', 'macro-enabled documents are not supported');
  }

  // 3. Validate every declared size before inflating anything.
  const real = files.filter(f => !f.dir);
  const declared = new Map<string, SizeInfo | undefined>();
  let declaredTotal = 0;
  for (const f of real) {
    const s = declaredSize(f);
    declared.set(f.name, s);
    if (!s) continue; // no size info: bounded inflation below enforces the total budget instead
    if (s.uncompressed > lim.maxUncompressedBytes) {
      throw new DocxOpenError('too-large', `entry ${f.name} declares ${s.uncompressed} bytes (limit ${lim.maxUncompressedBytes})`);
    }
    if (s.uncompressed > Math.max(s.compressed, 1) * lim.maxRatio) {
      throw new DocxOpenError('bomb', `entry ${f.name} compresses ${s.uncompressed}:${s.compressed} (limit ${lim.maxRatio}:1)`);
    }
    declaredTotal += s.uncompressed;
    if (declaredTotal > lim.maxUncompressedBytes) {
      throw new DocxOpenError('too-large', `package declares more than ${lim.maxUncompressedBytes} uncompressed bytes`);
    }
  }

  // 4. Inflate one entry at a time, each bounded by its declared size (or, if sizes were not
  //    available, by the remaining total budget). [Content_Types].xml goes first so a macro
  //    package is refused before anything else is expanded.
  const parts = new Map<string, Uint8Array>();
  let used = 0;
  const inflate = async (f: JSZip.JSZipObject) => {
    const s = declared.get(f.name);
    const bytes = await inflateEntry(f, f.name, s ? s.uncompressed : lim.maxUncompressedBytes - used, s?.uncompressed);
    used += bytes.length;
    if (used > lim.maxUncompressedBytes) {
      throw new DocxOpenError('too-large', `package exceeds ${lim.maxUncompressedBytes} uncompressed bytes`);
    }
    parts.set(f.name, bytes);
  };

  const ctFile = real.find(f => f.name === CONTENT_TYPES);
  if (!ctFile) throw new DocxOpenError('not-docx', 'missing [Content_Types].xml: not an OOXML package');
  await inflate(ctFile);
  const pkg = new Package(parts, data);
  // A malformed [Content_Types].xml throws DocxOpenError('corrupt') here.
  if (pkg.declaredContentTypes().some(t => MACRO_TYPE.test(t))) {
    throw new DocxOpenError('macro', 'macro-enabled documents are not supported');
  }
  for (const f of real) if (f !== ctFile) await inflate(f);

  return pkg;
}
