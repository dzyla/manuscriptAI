/**
 * Generator for the committed .docx test fixtures in src/test/fixtures/docx/.
 *
 * THIS SCRIPT IS THE ONLY SANCTIONED WAY these files are produced. Never hand-edit a
 * fixture, never commit a real/collaborator document, and never save one out of Word.
 * To add a fixture, add a builder here and re-run:
 *
 *     npx tsx scripts/fixtures/make-docx-fixtures.ts
 *
 * Output is deterministic (fixed entry dates, fixed timezone, fixed compression level) so
 * regenerating produces no spurious diffs. Later A2 tasks extend this file.
 *
 * Fixtures:
 *   minimal.docx    well-formed package, two paragraphs, styles, one internal + one external rel
 *   macro.docm      minimal + word/vbaProject.bin and a macro-enabled main content type
 *   bomb.docx       minimal + one 20 MB entry of a single byte (a few KB deflated, ratio > 1000)
 *   lying-size.docx like bomb.docx but the entry is word/bomb.xml (eagerly inflated), and the central directory UNDER-declares the entry's size
 *                   so the ratio guard passes; only bounded inflation can catch it
 *   traversal.docx minimal + an entry named ../evil.xml
 *   duplicate.docx minimal + two central-directory entries with the same name
 *   alias.docx     minimal + "./word/document.xml" appended: JSZip collapses it onto the real part
 *   alias-empty-segment.docx  same, with "word//document.xml"
 *   local-name-case-alias.docx  minimal + an entry whose CENTRAL name is zzzz/document.xml but whose
 *                   LOCAL-header name is word/DOCUMENT.xml (JSZip trusts the local header)
 *   content-types-decoy.docx  the real [Content_Types].xml declares a macro-enabled main part; a decoy
 *                   benign one, listed first, has central name [Content_Types].xmz / local name
 *                   [Content_Types].XML so a first-match, case-insensitive lookup would pick it
 *   swapped-local-names.docx  two records whose local-header names are swapped (same name SET, wrong owner)
 *   macro-content-type.docx  macro-enabled main content type but no vbaProject part (the content-type check alone)
 *   truncated.docx  valid zip whose word/document.xml is cut mid-element
 *   styles.docx     rich styles.xml: docDefaults (Arial 11pt, spacing), outline-level and name-matched headings,
 *                   inherited heading level, character style, a 3-deep basedOn chain, properties the app does not
 *                   model (keepNext, tabs, theme fonts, caps), a styleId that differs from its name, a table
 *                   style, a dangling basedOn and a basedOn cycle
 *   a4-margins.docx A4 body sectPr with 2 cm margins plus a US Letter sectPr inside a paragraph (an earlier section)
 *   no-styles.docx  minimal with no word/styles.xml part (the relationship to it dangles)
 *   bad-styles.docx minimal whose word/styles.xml is not well-formed XML
 */
process.env.TZ = 'UTC'; // must precede any Date use so zip timestamps are reproducible

import JSZip from 'jszip';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT_DIR = fileURLToPath(new URL('../../src/test/fixtures/docx/', import.meta.url));
const FIXED_DATE = new Date('2026-01-01T00:00:00Z');
// createFolders:false avoids implicit directory entries, which JSZip stamps with the current time.
const FILE_OPTS = { date: FIXED_DATE, createFolders: false };

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT_MAIN = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const CT_MACRO = 'application/vnd.ms-word.document.macroEnabled.main+xml';
const CT_STYLES = 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml';

const contentTypes = (main: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${main}"/><Override PartName="/word/styles.xml" ContentType="${CT_STYLES}"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${R}/hyperlink" Target="https://example.org/paper" TargetMode="External"/></Relationships>`;

const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Specific Aims</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph of plain text.</w:t></w:r></w:p></w:body></w:document>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style></w:styles>`;

const STYLES_RICH = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:link w:val="Heading1Char"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:spacing w:before="240" w:after="0"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="2E74B5"/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Heading1"/><w:next w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="SubAim"><w:name w:val="Sub Aim"/><w:basedOn w:val="Heading2"/></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="Titre3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:i/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Heading1Char"><w:name w:val="Heading 1 Char"/><w:link w:val="Heading1"/><w:rPr><w:b/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Emphasis"><w:name w:val="Emphasis"/><w:rPr><w:i/></w:rPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="Chain1"><w:name w:val="Chain 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="Chain2"><w:name w:val="Chain 2"/><w:basedOn w:val="Chain1"/><w:rPr><w:color w:val="C00000"/></w:rPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="Chain3"><w:name w:val="Chain 3"/><w:basedOn w:val="Chain2"/><w:rPr><w:i/></w:rPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="KeepTabs"><w:name w:val="Keep Tabs"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs><w:spacing w:before="120" w:after="60" w:line="360" w:lineRule="exact"/><w:ind w:left="720" w:hanging="360"/><w:jc w:val="both"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/><w:caps/><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="aimTitle"><w:name w:val="Aim Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="Dangling"><w:name w:val="Dangling"/><w:basedOn w:val="NoSuchStyle"/><w:rPr><w:b/></w:rPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="CycA"><w:name w:val="Cyc A"/><w:basedOn w:val="CycB"/></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="CycB"><w:name w:val="Cyc B"/><w:basedOn w:val="CycA"/></w:style>
</w:styles>`;

const A4_DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body><w:p><w:pPr><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:pPr><w:r><w:t>First section.</w:t></w:r></w:p><w:p><w:r><w:t>Second section.</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`;

function basePackage(opts: { main?: string; documentXml?: string; stylesXml?: string | null } = {}): JSZip {
  const zip = new JSZip();
  const add = (name: string, body: string | Uint8Array) => zip.file(name, body, FILE_OPTS);
  add('[Content_Types].xml', contentTypes(opts.main ?? CT_MAIN));
  add('_rels/.rels', ROOT_RELS);
  add('word/document.xml', opts.documentXml ?? DOCUMENT);
  add('word/_rels/document.xml.rels', DOC_RELS);
  if (opts.stylesXml !== null) add('word/styles.xml', opts.stylesXml ?? STYLES);
  return zip;
}

async function build(zip: JSZip): Promise<Uint8Array> {
  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
}

/** Find a 4-byte little-endian signature at or after `from`. */
function find(buf: Uint8Array, sig: number, from = 0): number {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = from; i + 4 <= buf.length; i++) if (dv.getUint32(i, true) === sig) return i;
  return -1;
}

/**
 * Rewrite the name in the LOCAL file header of the entry currently named `from` (central directory
 * untouched). Walks the local headers, so it never mistakes the same text inside entry data for a name.
 */
function patchLocalName(buf: Uint8Array, from: string, to: string): void {
  if (from.length !== to.length) throw new Error('patchLocalName needs equal-length names');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const dec = new TextDecoder();
  let pos = 0;
  while (pos + 30 <= buf.length && dv.getUint32(pos, true) === 0x04034b50) {
    const compressed = dv.getUint32(pos + 18, true);
    const nameLen = dv.getUint16(pos + 26, true);
    const extraLen = dv.getUint16(pos + 28, true);
    if (dec.decode(buf.subarray(pos + 30, pos + 30 + nameLen)) === from) {
      buf.set(new TextEncoder().encode(to), pos + 30);
      return;
    }
    pos += 30 + nameLen + extraLen + compressed;
  }
  throw new Error(`patchLocalName: local header for ${from} not found`);
}

const fixtures: Record<string, () => Promise<Uint8Array>> = {
  'minimal.docx': () => build(basePackage()),

  'macro.docm': () => {
    const zip = basePackage({ main: CT_MACRO });
    zip.file('word/vbaProject.bin', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]), FILE_OPTS);
    return build(zip);
  },

  'bomb.docx': () => {
    const zip = basePackage();
    zip.file('word/bomb.bin', new Uint8Array(20_000_000).fill(0x41), FILE_OPTS);
    return build(zip);
  },

  'lying-size.docx': async () => {
    const zip = basePackage();
    // An .xml part, so openPackage inflates it eagerly and the bound is exercised on open.
    zip.file('word/bomb.xml', new Uint8Array(20_000_000).fill(0x41), FILE_OPTS);
    const buf = await build(zip);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    // Walk the central directory and rewrite the declared uncompressed size of word/bomb.xml
    // from 20 MB down to 1 MB (offset 24 in a central file header). Ratio stays well under 100.
    let pos = find(buf, 0x02014b50);
    let patched = 0;
    while (pos >= 0 && dv.getUint32(pos, true) === 0x02014b50) {
      const nameLen = dv.getUint16(pos + 28, true);
      const extraLen = dv.getUint16(pos + 30, true);
      const commentLen = dv.getUint16(pos + 32, true);
      const name = new TextDecoder().decode(buf.subarray(pos + 46, pos + 46 + nameLen));
      if (name === 'word/bomb.xml') {
        dv.setUint32(pos + 24, 1_000_000, true);
        patched++;
      }
      pos += 46 + nameLen + extraLen + commentLen;
    }
    if (patched !== 1) throw new Error('lying-size: did not find exactly one bomb.xml entry to patch');
    return buf;
  },

  'traversal.docx': () => {
    const zip = basePackage();
    zip.file('../evil.xml', '<evil/>', FILE_OPTS);
    return build(zip);
  },

  'duplicate.docx': async () => {
    const zip = basePackage();
    zip.file('word/a.xml', '<a/>', FILE_OPTS);
    zip.file('word/b.xml', '<b/>', FILE_OPTS);
    const buf = await build(zip);
    // Rename word/b.xml -> word/a.xml (same length) in local and central headers.
    const from = new TextEncoder().encode('word/b.xml');
    const to = new TextEncoder().encode('word/a.xml');
    let n = 0;
    for (let i = 0; i + from.length <= buf.length; i++) {
      if (from.every((b, k) => buf[i + k] === b)) {
        buf.set(to, i);
        n++;
      }
    }
    if (n !== 2) throw new Error(`duplicate: expected 2 name occurrences, patched ${n}`);
    return buf;
  },

  'alias.docx': () => {
    const zip = basePackage();
    zip.file('./word/document.xml', '<w:document xmlns:w="urn:x"><w:body>ALIAS</w:body></w:document>', FILE_OPTS);
    return build(zip);
  },

  'alias-empty-segment.docx': () => {
    const zip = basePackage();
    zip.file('word//document.xml', '<w:document xmlns:w="urn:x"><w:body>ALIAS</w:body></w:document>', FILE_OPTS);
    return build(zip);
  },

  'local-name-case-alias.docx': async () => {
    const zip = basePackage();
    zip.file('zzzz/document.xml', '<pwn>PWNED</pwn>', FILE_OPTS);
    const buf = await build(zip);
    patchLocalName(buf, 'zzzz/document.xml', 'word/DOCUMENT.xml'); // central keeps zzzz/
    return buf;
  },

  'content-types-decoy.docx': async () => {
    const zip = new JSZip();
    // Decoy first, so a first-match search finds it before the real part.
    zip.file('[Content_Types].xmz', contentTypes(CT_MAIN), FILE_OPTS);
    zip.file('[Content_Types].xml', contentTypes(CT_MACRO), FILE_OPTS);
    zip.file('_rels/.rels', ROOT_RELS, FILE_OPTS);
    zip.file('word/document.xml', DOCUMENT, FILE_OPTS);
    zip.file('word/styles.xml', STYLES, FILE_OPTS);
    const buf = await build(zip);
    patchLocalName(buf, '[Content_Types].xmz', '[Content_Types].XML');
    return buf;
  },

  'swapped-local-names.docx': async () => {
    const zip = basePackage();
    zip.file('word/documenx.xml', '<pwn>PWNED</pwn>', FILE_OPTS);
    const buf = await build(zip);
    // Same two names, same set, but each record's LOCAL name is the other record's central name.
    patchLocalName(buf, 'word/document.xml', 'word/XXXXXXXX.xml');
    patchLocalName(buf, 'word/documenx.xml', 'word/document.xml');
    patchLocalName(buf, 'word/XXXXXXXX.xml', 'word/documenx.xml');
    return buf;
  },

  'macro-content-type.docx': () => build(basePackage({ main: CT_MACRO })),

  'styles.docx': () => build(basePackage({ stylesXml: STYLES_RICH })),

  'a4-margins.docx': () => build(basePackage({ documentXml: A4_DOCUMENT })),

  'no-styles.docx': () => build(basePackage({ stylesXml: null })),

  'bad-styles.docx': () => build(basePackage({ stylesXml: STYLES.slice(0, STYLES.indexOf('<w:name') + 8) })),

  'truncated.docx': () =>
    build(basePackage({ documentXml: DOCUMENT.slice(0, DOCUMENT.indexOf('<w:t>Second') + '<w:t>Sec'.length) })),
};

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, make] of Object.entries(fixtures)) {
    const bytes = await make();
    const limit = name === 'bomb.docx' || name === 'lying-size.docx' ? 200_000 : 100_000;
    if (bytes.length > limit) throw new Error(`${name} is ${bytes.length} bytes, over its ${limit} byte budget`);
    const path = OUT_DIR + name;
    writeFileSync(path, bytes);
    console.log(`wrote ${path} (${bytes.length} bytes)`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
