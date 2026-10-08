/**
 * OPC/.docx package reader. This is the security boundary for user-supplied files: every limit
 * below is enforced from the zip central directory BEFORE any entry is inflated, and inflation
 * itself is bounded so a header that lies about an entry's size cannot exhaust memory either.
 *
 * Pure and worker-safe: no React, no DOM globals, XML via @xmldom/xmldom only. Nothing in a
 * package is ever fetched; external relationships are only recorded.
 *
 * SYNC vs ASYNC ACCESS (read this before using the package in the reader):
 * JSZip can only inflate asynchronously, so openPackage() eagerly inflates the parts the sync
 * accessors (`entry`, `bytes`, `xml`, `rels`) serve. To stop a small upload from forcing the full
 * 300 MB uncompressed ceiling into memory, only parts that [Content_Types].xml identifies as XML
 * are eager, and only while their total stays within a 64 MB budget (`maxEagerBytes`). Everything
 * else (media, fonts, unknown binaries, and any XML part that did not fit the budget) is
 * "deferred": the sync accessors THROW DocxOpenError('too-large') for it (never `undefined`, which
 * means "part absent / feature not present" to every consumer, so a document whose XML overflowed
 * the budget cannot silently read as empty). A deferred part is reachable only through
 * `bytesAsync` / `entryAsync` / `xmlAsync`; `deferred()` lists them. On-demand reads are bounded
 * by the declared size and by `maxPartBytes` (32 MB) BEFORE anything is allocated. Deferred XML
 * parsed via `xmlAsync` goes through the same bounded DOM cache; raw deferred bytes are not. Ordinary documents (a few MB in
 * total) are entirely on the sync path for their XML; media always needs `bytesAsync`.
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

export const DEFAULT_LIMITS: Readonly<PackageLimits> = Object.freeze({
  maxCompressedBytes: 50e6,
  maxUncompressedBytes: 300e6,
  maxEntries: 2000,
  maxRatio: 100,
});

/** Total uncompressed bytes of XML parts that openPackage inflates eagerly for the sync accessors. */
export const DEFAULT_EAGER_BYTES = 64e6;

/**
 * Budget for the parsed-DOM cache, counted in SOURCE bytes of the cached parts. A parsed DOM costs
 * roughly 10-25x its source (measured on real grant documents), so 8 MB of source bounds the cache to
 * around 100-200 MB however large the package is. Least-recently-used documents are evicted; a part
 * bigger than the whole budget is parsed on every request and never cached.
 */
export const DEFAULT_MAX_CACHED_XML_BYTES = 8e6;

/** Largest single part the async accessors will inflate on demand (they allocate its declared size up front). */
export const DEFAULT_MAX_PART_BYTES = 32e6;

export interface OpenOptions extends Partial<PackageLimits> {
  /** Eager (sync-path) inflation budget; see the header comment. Default 64 MB. */
  maxEagerBytes?: number;
  /** Per-part cap for on-demand async reads of deferred parts. Default 32 MB. */
  maxPartBytes?: number;
  /** Parsed-DOM cache budget in source bytes (see DEFAULT_MAX_CACHED_XML_BYTES). 0 disables caching. */
  maxCachedXmlBytes?: number;
}

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
  /** Part as UTF-8 text; undefined when absent; throws DocxOpenError('too-large') when the part is deferred (use `entryAsync`). */
  entry(path: string): string | undefined;
  /** Raw part bytes (shared, do not mutate); undefined when absent; throws DocxOpenError('too-large') when deferred (use `bytesAsync`). */
  bytes(path: string): Uint8Array | undefined;
  /**
   * Part parsed as XML; treat as read-only. Parsed documents sit in a bounded LRU cache, so two calls may
   * return different objects for the same part (never hold a Document across other reads expecting identity);
   * undefined when absent; throws DocxOpenError('corrupt') when malformed and DocxOpenError('too-large') when deferred (use `xmlAsync`). */
  xml(path: string): Document | undefined;
  /** Drop a part's parsed document from the cache once a consumer is done with it. */
  releaseXml(path: string): void;
  /**
   * Relationships of a part (`''` for the package itself), keyed by Id; an empty map when the part has no
   * `.rels`. Throws DocxOpenError('corrupt') when the `.rels` part exists but is malformed or empty, and
   * DocxOpenError('too-large') when it exists but was deferred (it never silently reads as empty).
   */
  rels(partPath: string): Map<string, PackageRel>;
  contentType(path: string): string | undefined;
  /** Every part name in the package, including deferred ones. */
  names(): string[];
  /** Parts that exist but are only readable through the async accessors. */
  deferred(): string[];
  /** True when the part exists but is deferred (case-insensitive, like every accessor). False if absent or eager. */
  isDeferred(path: string): boolean;
  /** Async counterparts that also serve deferred parts (inflated on demand; throw 'too-large' above maxPartBytes). */
  bytesAsync(path: string): Promise<Uint8Array | undefined>;
  entryAsync(path: string): Promise<string | undefined>;
  xmlAsync(path: string): Promise<Document | undefined>;
  /** The untouched input, kept so A2b can re-emit parts it does not model. */
  original: ArrayBuffer;
}

const CONTENT_TYPES = '[Content_Types].xml';
const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
/** [Content_Types].xml is tiny in any real package; bound it separately from the generic limits. */
const MAX_CONTENT_TYPES_BYTES = 4e6;
const MAX_XML_DEPTH = 256;
const MACRO_NAME = /(^|\/)vbaproject(signature)?\.bin$/i;
const MACRO_TYPE = /macroEnabled|vbaProject|vbaData/i;

/**
 * Reject absolute paths, drive letters, NULs, and any `.`, `..` or empty path segment (after
 * `\` -> `/`). JSZip's loader runs names through resolve(), which drops `.` and empty segments and
 * collapses `a/../b`; accepting them would let an alias entry silently replace a real part.
 */
function checkEntryName(raw: string): void {
  const name = raw.replace(/\\/g, '/');
  const body = name.endsWith('/') ? name.slice(0, -1) : name; // directory entries end in one slash
  if (
    body === '' ||
    name.startsWith('/') ||
    /^[a-zA-Z]:/.test(name) ||
    name.includes('\0') ||
    body.split('/').some(seg => seg === '' || seg === '.' || seg === '..')
  ) {
    throw new DocxOpenError('bad-path', `unsafe entry name in package: ${JSON.stringify(raw.slice(0, 120))}`);
  }
}

/**
 * Walk the raw central directory (names and counts only) before JSZip builds an object per
 * record, so a file claiming a million empty entries is rejected without allocating them.
 * Returns the vetted central-directory names so the caller can require that JSZip (which takes
 * the authoritative name from the LOCAL header) ends up with exactly the same set.
 */
function scanCentralDirectory(data: ArrayBuffer, limits: PackageLimits): string[] {
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

  // Offsets in central records are relative to the start of the archive proper; tolerate prepended bytes.
  const zero = eocd - (cdOffset + cdSize);
  const seen = new Set<string>();
  const decoder = new TextDecoder('utf-8');
  const names: string[] = [];
  while (at(pos)) {
    // Count by walking records, not by the (forgeable) header total.
    if (names.length + 1 > limits.maxEntries) {
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
    names.push(name);
    // Pin each record to its own name: the local header at this record's offset must carry the same
    // name. A set-level comparison alone tolerates a permutation (two records with their local names
    // swapped), which would make this reader disagree with Word about which bytes are which part.
    const rel = dv.getUint32(pos + 42, true);
    if (rel === 0xffffffff) throw new DocxOpenError('too-large', 'zip64 packages are not supported');
    const lh = zero + rel;
    if (lh < 0 || lh + 30 > u8.length || dv.getUint32(lh, true) !== SIG_LOCAL) {
      throw new DocxOpenError('corrupt', `no local header for entry ${JSON.stringify(name.slice(0, 120))}`);
    }
    const lNameLen = dv.getUint16(lh + 26, true);
    if (lh + 30 + lNameLen > u8.length) throw new DocxOpenError('corrupt', 'truncated local header');
    const localName = decoder.decode(u8.subarray(lh + 30, lh + 30 + lNameLen));
    if (localName.replace(/\\/g, '/').toLowerCase() !== key) {
      throw new DocxOpenError('corrupt', `local header name differs from central directory name for ${JSON.stringify(name.slice(0, 120))}`);
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

interface SizeInfo {
  compressed: number;
  uncompressed: number;
}

/**
 * Declared sizes come from JSZip's per-entry CompressedObject (`_data`), which JSZip fills from
 * the central directory without inflating anything (verified in jszip 3.10.1). There is
 * deliberately no fallback: if a JSZip upgrade removes it we must fail loudly rather than
 * quietly lose the pre-inflation size checks.
 */
export function declaredSize(file: JSZip.JSZipObject): SizeInfo {
  const d = (file as any)._data;
  // JSZip replaces a loaded zero-length entry's CompressedObject with the empty string, which its
  // file() then wraps in a promise (verified in 3.10.1). A zero-length entry has nothing to bound.
  if (d === '' || (d && typeof d.then === 'function')) return { compressed: 0, uncompressed: 0 };
  if (
    d &&
    Number.isFinite(d.uncompressedSize) &&
    Number.isFinite(d.compressedSize) &&
    d.uncompressedSize >= 0 &&
    d.compressedSize >= 0
  ) {
    return { compressed: d.compressedSize, uncompressed: d.uncompressedSize };
  }
  throw new Error('jszip no longer exposes declared entry sizes (_data); the docx security checks need updating');
}

/**
 * Inflate one entry into a buffer preallocated to its declared size. A byte past that size aborts
 * (a header that under-declares), a short stream is corrupt. Overshoot before the abort is bounded
 * by what one 16 KB compressed input chunk can expand to, and those bytes are discarded.
 */
function inflateEntry(file: JSZip.JSZipObject, name: string, exact: number): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    let helper: any;
    try {
      helper = (file as any).internalStream('uint8array');
    } catch (e) {
      reject(new DocxOpenError('corrupt', `cannot read entry ${name}: ${(e as Error).message}`));
      return;
    }
    const out = new Uint8Array(exact);
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
        if (len + chunk.length > exact) {
          fail(new DocxOpenError('bomb', `entry ${name} inflates beyond its declared size`));
          return;
        }
        out.set(chunk, len);
        len += chunk.length;
      })
      .on('error', (e: Error) => fail(new DocxOpenError('corrupt', `cannot inflate entry ${name}: ${e.message}`)))
      .on('end', () => {
        if (settled) return;
        settled = true;
        if (len !== exact) reject(new DocxOpenError('corrupt', `entry ${name} is shorter than its declared size`));
        else resolve(out);
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

// TextDecoder strips a UTF-8 BOM and substitutes U+FFFD for invalid sequences.
const decodeUtf8 = (b: Uint8Array) => new TextDecoder('utf-8').decode(b);

function parseDoc(name: string, bytes: Uint8Array): Document {
  let doc: Document;
  try {
    doc = parseXmlStrict(decodeUtf8(bytes));
  } catch (e) {
    throw new DocxOpenError('corrupt', `${name} is not well-formed XML: ${(e as Error).message}`);
  }
  assertShallow(doc, name);
  return doc;
}

interface ContentTypes {
  defaults: Map<string, string>;
  overrides: Map<string, string>;
}

function readContentTypes(doc: Document): ContentTypes {
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
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
  return { defaults, overrides };
}

function lookupContentType(types: ContentTypes, path: string): string | undefined {
  const p = path.replace(/^\/+/, '');
  const override = types.overrides.get(p.toLowerCase());
  if (override) return override;
  const dot = p.lastIndexOf('.');
  return dot < 0 ? undefined : types.defaults.get(p.slice(dot + 1).toLowerCase());
}

/** XML by declared content type (application/xml, text/xml, anything +xml, relationships), else by extension. */
function isXmlPart(types: ContentTypes, path: string): boolean {
  const t = lookupContentType(types, path);
  if (t) return t === 'application/xml' || t === 'text/xml' || t.endsWith('+xml');
  return /\.(xml|rels)$/i.test(path);
}

class Package implements DocxPackage {
  /** lowercased part name -> real name (OPC part names are case-insensitive); covers deferred parts too. */
  private readonly index = new Map<string, string>();
  /** Parsed-DOM LRU cache (Map insertion order = recency), bounded by `cachedBytes` <= `maxCachedBytes` of source. */
  private readonly docs = new Map<string, { doc: Document; cost: number }>();
  private cachedBytes = 0;
  private readonly relCache = new Map<string, Map<string, PackageRel>>();

  constructor(
    private readonly parts: Map<string, Uint8Array>,
    private readonly files: Map<string, JSZip.JSZipObject>,
    private readonly sizes: Map<string, number>,
    private readonly types: ContentTypes,
    readonly original: ArrayBuffer,
    private readonly maxPartBytes: number,
    private readonly maxCachedBytes: number,
  ) {
    for (const name of files.keys()) this.index.set(name.toLowerCase(), name);
  }

  private resolve(path: string): string | undefined {
    const p = path.replace(/^\/+/, '');
    if (this.files.has(p)) return p;
    return this.index.get(p.toLowerCase());
  }

  /** Resolve for a sync read: undefined if absent, throws if the part exists but was deferred. */
  private resolveEager(path: string): string | undefined {
    const name = this.resolve(path);
    if (name !== undefined && !this.parts.has(name)) {
      throw new DocxOpenError('too-large', `${name} is not available synchronously (deferred); use the async accessors`);
    }
    return name;
  }

  private cached(name: string): Document | undefined {
    const hit = this.docs.get(name);
    if (!hit) return undefined;
    this.docs.delete(name); // refresh recency
    this.docs.set(name, hit);
    return hit.doc;
  }

  private remember(name: string, doc: Document, cost: number): void {
    if (cost > this.maxCachedBytes) return; // would evict everything and still not fit
    this.forget(name);
    this.docs.set(name, { doc, cost });
    this.cachedBytes += cost;
    for (const [oldest, entry] of this.docs) {
      if (this.cachedBytes <= this.maxCachedBytes) break;
      this.docs.delete(oldest);
      this.cachedBytes -= entry.cost;
    }
  }

  private forget(name: string): void {
    const entry = this.docs.get(name);
    if (!entry) return;
    this.docs.delete(name);
    this.cachedBytes -= entry.cost;
  }

  releaseXml(path: string): void {
    const name = this.resolve(path);
    if (name !== undefined) this.forget(name);
  }

  names(): string[] {
    return [...this.files.keys()];
  }

  deferred(): string[] {
    return [...this.files.keys()].filter(n => !this.parts.has(n));
  }

  isDeferred(path: string): boolean {
    const name = this.resolve(path);
    return name !== undefined && !this.parts.has(name);
  }

  bytes(path: string): Uint8Array | undefined {
    const name = this.resolveEager(path);
    return name === undefined ? undefined : this.parts.get(name);
  }

  entry(path: string): string | undefined {
    const b = this.bytes(path);
    return b === undefined ? undefined : decodeUtf8(b);
  }

  xml(path: string): Document | undefined {
    const name = this.resolveEager(path);
    if (name === undefined) return undefined;
    const cached = this.cached(name);
    if (cached) return cached;
    const bytes = this.parts.get(name)!;
    const doc = parseDoc(name, bytes);
    this.remember(name, doc, bytes.length);
    return doc;
  }

  async bytesAsync(path: string): Promise<Uint8Array | undefined> {
    const name = this.resolve(path);
    if (name === undefined) return undefined;
    const hit = this.parts.get(name);
    if (hit) return hit;
    // Check the cap BEFORE allocating: inflateEntry preallocates the declared size.
    const size = this.sizes.get(name)!;
    if (size > this.maxPartBytes) {
      throw new DocxOpenError('too-large', `${name} declares ${size} bytes (on-demand read limit ${this.maxPartBytes})`);
    }
    return inflateEntry(this.files.get(name)!, name, size);
  }

  async entryAsync(path: string): Promise<string | undefined> {
    const b = await this.bytesAsync(path);
    return b === undefined ? undefined : decodeUtf8(b);
  }

  async xmlAsync(path: string): Promise<Document | undefined> {
    const name = this.resolve(path);
    if (name === undefined) return undefined;
    const cached = this.cached(name);
    if (cached) return cached;
    const bytes = (await this.bytesAsync(name))!;
    const doc = parseDoc(name, bytes);
    this.remember(name, doc, bytes.length);
    return doc;
  }

  rels(partPath: string): Map<string, PackageRel> {
    const slash = partPath.lastIndexOf('/');
    const relsPath = `${partPath.slice(0, slash + 1)}_rels/${partPath.slice(slash + 1)}.rels`;
    const hit = this.relCache.get(relsPath);
    if (hit) return hit;
    const real = this.resolve(relsPath);
    if (real !== undefined && !this.parts.has(real)) {
      throw new DocxOpenError('too-large', `${real} is too large to read synchronously`);
    }
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

  contentType(path: string): string | undefined {
    return lookupContentType(this.types, path);
  }
}

export async function openPackage(data: ArrayBuffer, options: OpenOptions = {}): Promise<DocxPackage> {
  const {
    maxEagerBytes = DEFAULT_EAGER_BYTES,
    maxPartBytes = DEFAULT_MAX_PART_BYTES,
    maxCachedXmlBytes = DEFAULT_MAX_CACHED_XML_BYTES,
    ...limitOverrides
  } = options;
  const lim: PackageLimits = { ...DEFAULT_LIMITS, ...limitOverrides };

  // 1. Cheap checks on the raw bytes: no zip object has been built yet.
  if (!data || typeof data.byteLength !== 'number') throw new DocxOpenError('not-docx', 'no data');
  if (data.byteLength > lim.maxCompressedBytes) {
    throw new DocxOpenError('too-large', `file is ${data.byteLength} bytes (limit ${lim.maxCompressedBytes})`);
  }
  const scanned = scanCentralDirectory(data, lim);

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
  // JSZip takes each entry's authoritative name from the LOCAL header (or a 0x7075 Unicode-path extra
  // field), which the raw central-directory scan never sees. Require the names JSZip ended up with
  // to equal, as a multiset (case- and slash-normalised), the names we vetted. This closes every
  // route by which a record could be renamed, collapsed or shadowed (aliases, case variants, header
  // divergence) in one check, and fails before anything is inflated.
  const norm = (n: string) => n.replace(/\\/g, '/').toLowerCase();
  const expected = scanned.map(norm).sort();
  const actual = files.map(f => norm(f.name)).sort();
  if (expected.length !== actual.length || expected.some((n, i) => n !== actual[i])) {
    throw new DocxOpenError('corrupt', 'zip entry names disagree between the central directory and the local headers');
  }
  // JSZip normalises names (e.g. "../x" -> "x") and keeps the original; vet both.
  for (const f of files) {
    checkEntryName(f.name);
    if (f.unsafeOriginalName !== undefined) {
      checkEntryName(f.unsafeOriginalName);
      if (norm(f.unsafeOriginalName) !== norm(f.name)) {
        throw new DocxOpenError('corrupt', 'zip entry name was rewritten while loading');
      }
    }
    if (MACRO_NAME.test(f.name.replace(/\\/g, '/'))) throw new DocxOpenError('macro', 'macro-enabled documents are not supported');
  }

  // 3. Validate every declared size before inflating anything.
  const real = files.filter(f => !f.dir);
  const sizes = new Map<string, number>();
  let declaredTotal = 0;
  for (const f of real) {
    const s = declaredSize(f);
    sizes.set(f.name, s.uncompressed);
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

  // 4. [Content_Types].xml first: it drives the macro check and decides which parts are eager.
  const ctFile = real.find(f => f.name.toLowerCase() === CONTENT_TYPES.toLowerCase());
  if (!ctFile) throw new DocxOpenError('not-docx', 'missing [Content_Types].xml: not an OOXML package');
  const parts = new Map<string, Uint8Array>();
  const ctCap = Math.min(maxPartBytes, MAX_CONTENT_TYPES_BYTES);
  if (sizes.get(ctFile.name)! > ctCap) {
    // inflateEntry preallocates the declared size, so refuse before allocating.
    throw new DocxOpenError('too-large', `[Content_Types].xml declares ${sizes.get(ctFile.name)} bytes (limit ${ctCap})`);
  }
  const ctBytes = await inflateEntry(ctFile, ctFile.name, sizes.get(ctFile.name)!);
  parts.set(ctFile.name, ctBytes);
  const types = readContentTypes(parseDoc(ctFile.name, ctBytes)); // malformed -> corrupt
  for (const t of [...types.overrides.values(), ...types.defaults.values()]) {
    if (MACRO_TYPE.test(t)) throw new DocxOpenError('macro', 'macro-enabled documents are not supported');
  }

  // 5. Eagerly inflate XML parts within the budget; everything else is deferred (see header comment).
  let eager = ctBytes.length;
  for (const f of real) {
    if (f === ctFile || !isXmlPart(types, f.name)) continue;
    const size = sizes.get(f.name)!;
    if (eager + size > maxEagerBytes) continue; // deferred; a smaller later part may still fit
    parts.set(f.name, await inflateEntry(f, f.name, size));
    eager += size;
  }

  return new Package(parts, new Map(real.map(f => [f.name, f])), sizes, types, data, maxPartBytes, maxCachedXmlBytes);
}
