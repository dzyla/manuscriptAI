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
 *   localised-styles.docx  French/German style ids over English built-in names (Standard=Normal, Titre1=heading 1,
 *                   \u00dcberschrift2=heading 2, Legende=caption), a custom style whose only child is rPr, a style with
 *                   no styleId, a root paragraph style, a table style, and ~15 unused namespaces on the root
 *   no-styles.docx  minimal with no word/styles.xml part (the relationship to it dangles)
 *   bad-styles.docx minimal whose word/styles.xml is not well-formed XML
 *   body-basics.docx  paragraph/run/hyperlink coverage: Heading1/2, Caption, bold/italic/underline/strike, font+size+colour,
 *                   super/subscript, a character style, page breaks (alone and inside text), http/mailto/file/javascript/anchor
 *                   hyperlinks, justify+spacing+indent, hanging indent, outlineLvl heading, keepNext+tabs, a smartTag wrapper,
 *                   an equation, a footnote reference inside a formatted run, a tracked insertion, a non-Google content control
 *   unstyled-sections.docx  a grant-shaped document with NO heading styles: section titles are bold Normal paragraphs (known section
 *                   names, an enumerated one, a formatted sub-heading, a larger-font line, one led by a page break, one with a comment
 *                   anchor), plus the shapes that must NOT be detected (bold lead-in sharing a paragraph with body text, a bold
 *                   sentence mid-paragraph, a 14-word bold line, a figure label, a bookmarked title, a title with a tracked insertion)
 *   lists.docx      word/numbering.xml with bullet, decimal, start=3, startOverride, upperRoman "(%1)" and ordinalText levels; two-level bullet
 *                   and numbered lists, a start-3 list, a list item with a second (continuation) paragraph (indented, and one in the List Continue style), a numbered list interrupted by a
 *                   plain paragraph and resumed on the same numId, list-style (no direct numPr) items, a numbered Heading1, a missing numId,
 *                   numId 0, a bold list item that would read as a section title, items holding a page break / an equation, a skipped
 *                   level and a list that starts below its first level
 *   tables.docx     one 4-column table (grid 1800/2700/3600/1440 twips, distinct) with w:tblBorders and a Table Grid style: a tblHeader row, a
 *                   gridSpan=2 cell, a vMerge restart (row 1, column 1) with its continuation in row 2, a two-paragraph cell, a cell holding a
 *                   nested 2x2 table, an empty cell; one paragraph before and one after the table
 *   images.docx     word/media with two PNGs (A, B; solid colours, valid), a WebP and the pieces Task 9 reads: an inline PNG A (centred) followed by a
 *                   Caption-styled paragraph; a wrapSquare PNG B anchored in a paragraph of text with the offset and relativeFrom the real R01
 *                   uses (right of centre); a wrapSquare PNG A (the same bytes, a second reference) anchored near the left edge; a
 *                   wrapTopAndBottom PNG B centred; an inline image whose r:embed is not in the rels; an image linked from
 *                   https://example.org (TargetMode="External", r:link only); an inline WebP
 *   opaque.docx     one of each thing the reader keeps as an opaque atom: an m:oMath equation, a footnote reference (with a footnotes.xml
 *                   part), a non-Google content control, a bookmarkStart/bookmarkEnd pair, a complex field the reader does not model
 *                   (PAGEREF) with an editable result, a w:object OLE object (with its embedding and preview-image relationships) and a
 *                   paragraph-level sectPr; every piece of text is a distinct word
 *   google-export.docx  Google Docs shape: goog_rdk_* w:sdt wrappers (one nested two deep) around runs, plus word/fonts/ font
 */
process.env.TZ = 'UTC'; // must precede any Date use so zip timestamps are reproducible

import JSZip from 'jszip';
import { deflateSync } from 'node:zlib';
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

const EXTRA_NS = ['w14', 'w15', 'w16se', 'wp', 'wp14', 'a', 'pic', 'm', 'v', 'o', 'w10', 'wne', 'wpg', 'wps', 'mc']
  .map(p => `xmlns:${p}="urn:example:${p}"`)
  .join(' ');

const STYLES_LOCALISED = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}" ${EXTRA_NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Standard"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Titre1"><w:name w:val="heading 1"/><w:basedOn w:val="Standard"/><w:next w:val="Standard"/><w:pPr><w:keepNext/><w:spacing w:after="0"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="\u00dcberschrift2"><w:name w:val="heading 2"/><w:basedOn w:val="Standard"/><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Legende"><w:name w:val="caption"/><w:basedOn w:val="Standard"/><w:rPr><w:i/></w:rPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="OnlyBold"><w:name w:val="Only Bold"/><w:rPr><w:b/></w:rPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="Rootless"><w:name w:val="Rootless"/><w:pPr><w:spacing w:before="100"/></w:pPr></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableauNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/></w:tblPr></w:style>
<w:style w:type="paragraph" w:customStyle="1"><w:name w:val="No Id"/></w:style>
</w:styles>`;

const A4_DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body><w:p><w:pPr><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:pPr><w:r><w:t>First section.</w:t></w:r></w:p><w:p><w:r><w:t>Second section.</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`;

const STYLES_BODY = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:rPr><w:i/><w:sz w:val="18"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Emphasis"><w:name w:val="Emphasis"/><w:rPr><w:i/></w:rPr></w:style>
</w:styles>`;

const BODY_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/><Relationship Id="rId10" Type="${R}/hyperlink" Target="https://example.org/paper" TargetMode="External"/><Relationship Id="rId11" Type="${R}/hyperlink" Target="mailto:author@example.org" TargetMode="External"/><Relationship Id="rId12" Type="${R}/hyperlink" Target="file:///etc/passwd" TargetMode="External"/><Relationship Id="rId13" Type="${R}/hyperlink" Target="javascript:alert(1)" TargetMode="External"/><Relationship Id="rId14" Type="${R}/hyperlink" Target="media/note.txt"/></Relationships>`;

const run = (text: string, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;

const BODY_BASICS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${run('Aims Overview')}</w:p>
<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr>${run('Background Section')}</w:p>
<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr>${run('Plain ')}${run('boldword', '<w:b/>')}${run(' ')}${run('italicword', '<w:i/>')}${run(' ')}${run('underlineword', '<w:u w:val="single"/>')}${run(' ')}${run('strikeword', '<w:strike/>')}${run(' ')}${run('notbold', '<w:b w:val="0"/><w:u w:val="none"/>')}</w:p>
<w:p>${run('styledword', '<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:sz w:val="28"/><w:color w:val="FF0000"/>')}${run(' H')}${run('2', '<w:vertAlign w:val="subscript"/>')}${run('O and x')}${run('2', '<w:vertAlign w:val="superscript"/>')}</w:p>
<w:p>${run('emphaticword', '<w:rStyle w:val="Emphasis"/>')}${run(' and ')}${run('markedword', '<w:highlight w:val="yellow"/>')}</w:p>
<w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr>${run('Figure 1. A caption.')}</w:p>
<w:p><w:r><w:br w:type="page"/></w:r></w:p>
<w:p>${run('Before break ')}<w:r><w:br w:type="page"/></w:r>${run('After break')}</w:p>
<w:p>${run('Visit ')}<w:hyperlink r:id="rId10">${run('webcitation', '<w:b/>')}</w:hyperlink>${run(' or ')}<w:hyperlink r:id="rId11">${run('mailtolink')}</w:hyperlink>${run(' or ')}<w:hyperlink r:id="rId12">${run('filelink')}</w:hyperlink>${run(' or ')}<w:hyperlink r:id="rId13">${run('scriptlink')}</w:hyperlink>${run(' or ')}<w:hyperlink w:anchor="_Toc1">${run('anchorlink')}</w:hyperlink>${run(' or ')}<w:hyperlink r:id="rId14">${run('internallink')}</w:hyperlink>${run(' or ')}<w:hyperlink r:id="rId99">${run('danglinglink')}</w:hyperlink></w:p>
<w:p><w:pPr><w:jc w:val="both"/><w:spacing w:before="240" w:after="120" w:line="360" w:lineRule="auto"/><w:ind w:left="720" w:firstLine="360"/></w:pPr>${run('justified paragraph')}</w:p>
<w:p><w:pPr><w:spacing w:line="280" w:lineRule="exact"/><w:ind w:left="720" w:hanging="360"/></w:pPr>${run('hanging paragraph')}</w:p>
<w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr>${run('outline heading')}</w:p>
<w:p><w:pPr><w:keepNext/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>${run('keep with next')}</w:p>
<w:p><w:smartTag w:uri="urn:schemas-microsoft-com:office:smarttags" w:element="place">${run('Denver')}</w:smartTag>${run(' is high.')}</w:p>
<w:p>${run('lead ')}<w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t xml:space="preserve"> c </w:t><w:noBreakHyphen/><w:t>d</w:t></w:r><w:r><w:t>   trimmed   </w:t></w:r></w:p>
<w:p>${run('Equation: ')}<m:oMath><m:r><m:t>x+1</m:t></m:r></m:oMath>${run(' after.')}</w:p>
<w:p>${run('See note')}<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="2"/></w:r>${run(' end.')}</w:p>
<w:p>${run('Revised ')}<w:ins w:id="7" w:author="Reviewer" w:date="2026-01-01T00:00:00Z"><w:r><w:t>insertedword</w:t></w:r></w:ins>${run(' text.')}</w:p>
<w:p>${run('Control: ')}<w:sdt><w:sdtPr><w:tag w:val="my_control"/></w:sdtPr><w:sdtContent>${run('controlled')}</w:sdtContent></w:sdt></w:p>
<w:p/>
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;

const goog = (n: number, inner: string) =>
  `<w:sdt><w:sdtPr><w:tag w:val="goog_rdk_${n}"/></w:sdtPr><w:sdtContent>${inner}</w:sdtContent></w:sdt>`;

const GOOGLE_EXPORT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>
<w:p>${goog(0, run('wrappedonce'))}</w:p>
<w:p>${goog(1, run('outer ') + goog(2, run('wrappedtwice', '<w:b/>')))}</w:p>
<w:p>${run('Plain tail.')}</w:p>
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;

const bold = '<w:b/>';
const UNSTYLED_SECTIONS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>
<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${run('Mitochondrial Stress Signalling in Muscle', bold)}</w:p>
<w:p>${run('Specific Aims', bold)}</w:p>
<w:p>${run('Skeletal muscle loses mass with age, and the stress responses that protect it are poorly understood. We propose to define how these responses are coordinated across tissues and over time.')}</w:p>
<w:p>${run('A. Significance', bold)}</w:p>
<w:p>${run('Muscle decline is a leading cause of frailty. Understanding its drivers will change how it is treated.')}</w:p>
<w:p>${run('Aim 1: Define the mechanism', bold)}</w:p>
<w:p>${run('We will map the signalling pathway in cultured myotubes and in mice.')}</w:p>
<w:p>${run('Approach', bold)}${run(' We will use a combination of imaging, proteomics and genetics to test each prediction in turn.')}</w:p>
<w:p>${run('Earlier work established the basis. ')}${run('Thrombin cleaves the receptor within seconds.', bold)}${run(' This motivates the present proposal.')}</w:p>
<w:p>${run('Vertebrate Animals', bold)}${run(' ')}</w:p>
<w:p>${run('All procedures follow institutional guidelines and have been approved by the committee.')}</w:p>
<w:p>${run('The overall objective of this application is to determine how stress signalling remodels muscle', bold)}</w:p>
<w:p>${run('The remainder of this paragraph is ordinary body text that follows the long bold line.')}</w:p>
<w:p>${run('Figure 1', bold)}</w:p>
<w:p>${run('A schematic of the pathway is shown above.')}</w:p>
<w:p>${run('Timeline of Experiments', '<w:sz w:val="40"/>')}</w:p>
<w:p>${run('Year one covers the cell work; year two covers the animal work.')}</w:p>
<w:p><w:r><w:br w:type="page"/></w:r>${run('Results', bold)}</w:p>
<w:p>${run('Knockdown reduced the response by half in every line tested.')}</w:p>
<w:p><w:bookmarkStart w:id="1" w:name="_Ref1"/>${run('Discussion', bold)}<w:bookmarkEnd w:id="1"/></w:p>
<w:p>${run('These data suggest a conserved mechanism that deserves further study.')}</w:p>
<w:p><w:commentRangeStart w:id="5"/>${run('Innovation', bold)}<w:commentRangeEnd w:id="5"/><w:r><w:commentReference w:id="5"/></w:r></w:p>
<w:p>${run('The approach combines two methods that have not been used together before.')}</w:p>
<w:p>${run('Conclusion', bold)}<w:ins w:id="9" w:author="Reviewer" w:date="2026-01-01T00:00:00Z"><w:r><w:t xml:space="preserve"> and outlook</w:t></w:r></w:ins></w:p>
<w:p>${run('We conclude that the pathway is required for maintenance of muscle.')}</w:p>
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;

// ─── lists.docx ──────────────────────────────────────────────────────────────

const CT_NUMBERING = 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml';

const lvl = (ilvl: number, fmt: string, text: string, left: number, extra = '') =>
  `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/>${extra}<w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr></w:lvl>`;

const NUMBERING_LISTS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W}">
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${lvl(0, 'bullet', '•', 720, '<w:pStyle w:val="ListBullet"/>')}${lvl(1, 'bullet', 'o', 1440)}</w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${lvl(0, 'decimal', '%1.', 720, '<w:pStyle w:val="ListNumber"/>')}${lvl(1, 'lowerLetter', '%2.', 1440)}${lvl(2, 'lowerRoman', '%3.', 2160)}</w:abstractNum>
<w:abstractNum w:abstractNumId="2"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="3"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="3"><w:multiLevelType w:val="multilevel"/>${lvl(0, 'upperRoman', '(%1)', 720)}${lvl(1, 'ordinalText', '%1.%2', 1440)}</w:abstractNum>
<w:abstractNum w:abstractNumId="4"><w:multiLevelType w:val="hybridMultilevel"/>${lvl(0, 'decimal', '%1.', 720)}</w:abstractNum>
<w:abstractNum w:abstractNumId="5"><w:multiLevelType w:val="hybridMultilevel"/>${lvl(0, 'decimal', '%1.', 720)}</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
<w:num w:numId="3"><w:abstractNumId w:val="2"/></w:num>
<w:num w:numId="4"><w:abstractNumId w:val="4"/></w:num>
<w:num w:numId="5"><w:abstractNumId w:val="5"/></w:num>
<w:num w:numId="6"><w:abstractNumId w:val="3"/></w:num>
<w:num w:numId="7"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride></w:num>
</w:numbering>`;

const STYLES_LISTS = STYLES_BODY.replace(
  '</w:styles>',
  `<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="ListNumber"><w:name w:val="List Number"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:numId w:val="2"/></w:numPr></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="ListNumber2"><w:name w:val="List Number 2"/><w:basedOn w:val="ListNumber"/></w:style>
<w:style w:type="paragraph" w:styleId="ListContinue"><w:name w:val="List Continue"/><w:basedOn w:val="Normal"/></w:style>
</w:styles>`,
);

const num = (numId: number, ilvl: number) => `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`;
/** A list paragraph. */
const li = (text: string, numId: number, ilvl: number, extraRuns = '', pPrExtra = '') =>
  `<w:p><w:pPr>${num(numId, ilvl)}${pPrExtra}</w:pPr>${run(text)}${extraRuns}</w:p>`;
const plain = (text: string, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${run(text)}</w:p>`;

const LISTS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>
${plain('Intro paragraph.')}
${li('Bullet A', 1, 0)}
${li('Bullet A1', 1, 1)}
${li('Bullet A2', 1, 1)}
${li('Bullet B', 1, 0)}
${plain('Between lists one.')}
${li('Step one', 2, 0)}
${li('Step one a', 2, 1)}
${li('Step one b', 2, 1)}
${li('Step two', 2, 0)}
${li('Step two a', 2, 1)}
${plain('Between lists two.')}
${li('Third', 3, 0)}
${li('Fourth', 3, 0)}
${plain('Between lists three.')}
${li('Item with two paragraphs', 4, 0)}
${plain('Continuation of that item.', '<w:ind w:left="720"/>')}
${li('Next item', 4, 0)}
<w:p><w:pPr><w:pStyle w:val="ListContinue"/></w:pPr>${run('Style continuation of that item.')}</w:p>
${plain('Between lists four.')}
${li('Resume one', 5, 0)}
${li('Resume two', 5, 0)}
${plain('Interrupting paragraph.')}
${li('Resume three', 5, 0)}
${li('Resume four', 5, 0)}
${plain('Between lists five.')}
${li('Roman one', 6, 0)}
${li('Ordinal sub', 6, 1)}
${plain('Between lists six.')}
<w:p><w:pPr><w:pStyle w:val="ListBullet"/></w:pPr>${run('Style bullet')}</w:p>
<w:p><w:pPr><w:pStyle w:val="ListNumber2"/></w:pPr>${run('Style numbered')}</w:p>
${plain('Between lists seven.')}
<w:p><w:pPr><w:pStyle w:val="Heading1"/>${num(2, 0)}</w:pPr>${run('Numbered heading text')}</w:p>
${li('Missing definition', 99, 0)}
${li('Zero numbering', 0, 0)}
${plain('Between lists eight.')}
<w:p><w:pPr>${num(1, 0)}</w:pPr>${run('Specific Aims', bold)}</w:p>
${plain('We will define how muscle stress responses are coordinated across tissues and over time, and test each prediction in cultured cells and in mice.')}
${plain('Between lists nine.')}
${li('Item with a break', 7, 0, '<w:r><w:br w:type="page"/></w:r>')}
${li('Item with equation', 7, 0, '<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath>')}
${plain('Between lists ten.')}
${li('Skips down', 2, 0)}
${li('Deep item', 2, 2)}
${plain('Between lists eleven.')}
${li('Starts indented', 2, 1)}
${plain('Closing paragraph.')}
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;

const LISTS_RELS = BODY_RELS.replace(
  '</Relationships>',
  `<Relationship Id="rId20" Type="${R}/numbering" Target="numbering.xml"/></Relationships>`,
);

// ─── tables.docx ─────────────────────────────────────────────────────────────

const STYLES_TABLES = STYLES_BODY.replace(
  '</w:styles>',
  `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/></w:tblPr></w:style>
</w:styles>`,
);

const BORDER = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`;
/** A cell: text paragraphs, optionally spanning grid columns and carrying a w:vMerge ('restart' | 'continue'). */
const tc = (w: number, inner: string, extra = '') => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${extra}</w:tcPr>${inner}</w:tc>`;
const NESTED_TABLE = `<w:tbl><w:tblPr><w:tblW w:w="1800" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="900"/><w:gridCol w:w="900"/></w:tblGrid>
<w:tr>${tc(900, plain('nested 1'))}${tc(900, plain('nested 2'))}</w:tr>
<w:tr>${tc(900, plain('nested 3'))}${tc(900, plain('nested 4'))}</w:tr></w:tbl>`;

const TABLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>
${plain('Before the table.')}
<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="9540" w:type="dxa"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(BORDER).join('')}</w:tblBorders><w:tblLook w:val="04A0"/></w:tblPr>
<w:tblGrid><w:gridCol w:w="1800"/><w:gridCol w:w="2700"/><w:gridCol w:w="3600"/><w:gridCol w:w="1440"/></w:tblGrid>
<w:tr><w:trPr><w:tblHeader/></w:trPr>${tc(1800, plain('Head A'))}${tc(2700, plain('Head B'))}${tc(3600, plain('Head C'))}${tc(1440, plain('Head D'))}</w:tr>
<w:tr>${tc(1800, plain('Tall cell'), '<w:vMerge w:val="restart"/>')}${tc(6300, plain('Wide cell'), '<w:gridSpan w:val="2"/>')}${tc(1440, plain('r1 c4'))}</w:tr>
<w:tr>${tc(1800, '<w:p/>', '<w:vMerge/>')}${tc(2700, plain('r2 c2 first paragraph') + plain('r2 c2 second paragraph'))}${tc(3600, plain('r2 c3'))}${tc(1440, plain('r2 c4'))}</w:tr>
<w:tr>${tc(1800, plain('r3 c1'))}${tc(2700, NESTED_TABLE + '<w:p/>')}${tc(3600, '<w:p/>')}${tc(1440, plain('r3 c4'))}</w:tr>
</w:tbl>
${plain('After the table.')}
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;

// ─── images.docx ─────────────────────────────────────────────────────────────

const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const DML = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PICNS = 'http://schemas.openxmlformats.org/drawingml/2006/picture';

function crc32(buf: Uint8Array): number {
  let c: number;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A valid solid-colour RGB PNG (header, IHDR, IDAT, IEND, real CRCs), so a browser and the sniffer both accept it. */
function png(r: number, g: number, b: number, w = 4, h = 4): Uint8Array {
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = new Uint8Array(1 + w * 3);
  for (let x = 0; x < w; x++) row.set([r, g, b], 1 + x * 3);
  const raw = new Uint8Array(row.length * h);
  for (let y = 0; y < h; y++) raw.set(row, y * row.length);
  const idat = new Uint8Array(deflateSync(raw, { level: 9 }));
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A 1x1 lossless WebP: Word cannot place one, and A1's exporter used to drop it. */
const WEBP = Uint8Array.from(Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64'));

const IN = 914400;
const emu = (inches: number) => Math.round(inches * IN);

/** A picture's `a:graphic`; `link`/`embed` are the relationship ids on the blip. */
const picGraphic = (id: number, name: string, ref: { embed?: string; link?: string }, extra = '') =>
  `<a:graphic xmlns:a="${DML}"><a:graphicData uri="${PICNS}"><pic:pic xmlns:pic="${PICNS}"><pic:nvPicPr><pic:cNvPr id="${id}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip${ref.embed ? ` r:embed="${ref.embed}"` : ''}${ref.link ? ` r:link="${ref.link}"` : ''}/>${extra}<a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>`;

const inlineDrawing = (id: number, name: string, ref: { embed?: string; link?: string }, wIn: number, hIn: number, descr = '') =>
  `<w:r><w:drawing><wp:inline xmlns:wp="${WP}" distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${emu(wIn)}" cy="${emu(hIn)}"/><wp:docPr id="${id}" name="${name}"${descr ? ` descr="${descr}"` : ''}/>${picGraphic(id, name, ref)}</wp:inline></w:drawing></w:r>`;

/** An anchored picture: `wrap` is the wp:wrap* element; `posH` the wp:positionH. Offsets as the real R01 has them (relativeFrom column, posOffset). */
const anchorDrawing = (id: number, name: string, embed: string, wIn: number, hIn: number, wrap: string, posH: string, behindDoc = 0) =>
  `<w:r><w:drawing><wp:anchor xmlns:wp="${WP}" distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="0" behindDoc="${behindDoc}" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>${posH}<wp:positionV relativeFrom="paragraph"><wp:posOffset>1123315</wp:posOffset></wp:positionV><wp:extent cx="${emu(wIn)}" cy="${emu(hIn)}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>${wrap}<wp:docPr id="${id}" name="${name}" descr="Floating ${name}"/>${picGraphic(id, name, { embed })}</wp:anchor></w:drawing></w:r>`;

const posOffsetH = (emuOffset: number) => `<wp:positionH relativeFrom="column"><wp:posOffset>${emuOffset}</wp:posOffset></wp:positionH>`;
const posAlignH = (align: string) => `<wp:positionH relativeFrom="margin"><wp:align>${align}</wp:align></wp:positionH>`;

const IMAGES_RELS = BODY_RELS.replace(
  '</Relationships>',
  `<Relationship Id="rId20" Type="${R}/image" Target="media/image1.png"/><Relationship Id="rId21" Type="${R}/image" Target="media/image2.png"/><Relationship Id="rId22" Type="${R}/image" Target="media/image3.webp"/><Relationship Id="rId30" Type="${R}/image" Target="https://example.org/figures/linked.png" TargetMode="External"/></Relationships>`,
);

const IMAGES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>
${plain('Introductory paragraph.')}
<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${inlineDrawing(1, 'Inline A', { embed: 'rId20' }, 3.25, 2, 'Inline figure alt text')}</w:p>
<w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr>${run('Figure 1. Inline figure caption.')}</w:p>
<w:p>${anchorDrawing(2, 'Right B', 'rId21', 3.55, 1.18, `<wp:wrapSquare wrapText="bothSides" distT="0" distB="0" distL="0" distR="0"/>`, posOffsetH(3609975))}${run('Text beside the picture that floats to the right.')}</w:p>
<w:p>${anchorDrawing(3, 'Left A', 'rId20', 4.2, 4.06, `<wp:wrapSquare wrapText="bothSides" distT="0" distB="0" distL="114300" distR="114300"/>`, posOffsetH(4446))}${run('Text beside the picture that floats to the left.')}</w:p>
<w:p>${anchorDrawing(4, 'Centred B', 'rId21', 4, 1.5, '<wp:wrapTopAndBottom/>', posAlignH('center'))}${run('Text above and below the centred picture.')}</w:p>
<w:p>${inlineDrawing(5, 'Missing', { embed: 'rId99' }, 2, 1)}</w:p>
<w:p>${inlineDrawing(6, 'Linked', { link: 'rId30' }, 2, 1, 'A linked picture')}</w:p>
<w:p>${inlineDrawing(7, 'WebP', { embed: 'rId22' }, 1, 1)}</w:p>
${plain('Closing paragraph.')}
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;

function basePackage(
  opts: { main?: string; documentXml?: string; stylesXml?: string | null; relsXml?: string; extra?: Record<string, string | Uint8Array>; contentTypesXml?: string } = {},
): JSZip {
  const zip = new JSZip();
  const add = (name: string, body: string | Uint8Array) => zip.file(name, body, FILE_OPTS);
  add('[Content_Types].xml', opts.contentTypesXml ?? contentTypes(opts.main ?? CT_MAIN));
  add('_rels/.rels', ROOT_RELS);
  add('word/document.xml', opts.documentXml ?? DOCUMENT);
  add('word/_rels/document.xml.rels', opts.relsXml ?? DOC_RELS);
  for (const [name, body] of Object.entries(opts.extra ?? {})) add(name, body);
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

// ─── opaque.docx (Task 10) ───────────────────────────────────────────────────────────────────────────────────────
const CT_FOOTNOTES = 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml';

const FOOTNOTES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="${W}" xmlns:r="${R}"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:t>Footnote body text.</w:t></w:r></w:p></w:footnote></w:footnotes>`;

const OPAQUE_RELS = BODY_RELS.replace(
  '</Relationships>',
  `<Relationship Id="rId31" Type="${R}/footnotes" Target="footnotes.xml"/><Relationship Id="rId40" Type="${R}/oleObject" Target="embeddings/oleObject1.bin"/><Relationship Id="rId41" Type="${R}/image" Target="media/image1.png"/></Relationships>`,
);

const fld = (type: string) => `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`;

/**
 * Every paragraph states a distinct word per piece of editable text, so a test can prove that the words outside the atoms are
 * in the document's text and the words inside them are in exactly one stored fragment.
 */
const OPAQUE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><w:body>
<w:p>${run('Equationbefore ')}<m:oMath><m:r><m:t>x+1</m:t></m:r></m:oMath>${run(' equationafter.')}</w:p>
<w:p>${run('Notetext')}<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="1"/></w:r>${run(' noteend.')}</w:p>
<w:p>${run('Controlbefore ')}<w:sdt><w:sdtPr><w:tag w:val="my_control"/></w:sdtPr><w:sdtContent>${run('controlledtext')}</w:sdtContent></w:sdt>${run(' controlafter.')}</w:p>
<w:p>${run('Markstart ')}<w:bookmarkStart w:id="5" w:name="_Ref100"/>${run('markedwords')}<w:bookmarkEnd w:id="5"/>${run(' markend.')}</w:p>
<w:p>${run('Fieldbefore ')}${fld('begin')}<w:r><w:instrText xml:space="preserve"> PAGEREF _Ref100 \\h </w:instrText></w:r>${fld('separate')}${run('fieldresult')}${fld('end')}${run(' fieldafter.')}</w:p>
<w:p>${run('Objectbefore ')}<w:r><w:object w:dxaOrig="1440" w:dyaOrig="1440"><v:shape id="_x0000_i1025" type="#_x0000_t75" style="width:72pt;height:72pt"><v:imagedata r:id="rId41" o:title=""/></v:shape><o:OLEObject Type="Embed" ProgID="Package" ShapeID="_x0000_i1025" DrawAspect="Content" ObjectID="_1" r:id="rId40"/></w:object></w:r>${run(' objectafter.')}</w:p>
<w:p><w:pPr><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:pPr>${run('Sectionone ends here.')}</w:p>
<w:p>${run('Lastparagraph.')}</w:p>
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;

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

  'localised-styles.docx': () => build(basePackage({ stylesXml: STYLES_LOCALISED })),

  'no-styles.docx': () => build(basePackage({ stylesXml: null })),

  'bad-styles.docx': () => build(basePackage({ stylesXml: STYLES.slice(0, STYLES.indexOf('<w:name') + 8) })),

  'body-basics.docx': () =>
    build(basePackage({ documentXml: BODY_BASICS, stylesXml: STYLES_BODY, relsXml: BODY_RELS })),

  'google-export.docx': () =>
    build(
      basePackage({
        documentXml: GOOGLE_EXPORT,
        contentTypesXml: contentTypes(CT_MAIN).replace(
          '<Override',
          '<Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/><Override',
        ),
        // Not a real font: only the part's presence under word/fonts/ matters to the reader.
        extra: { 'word/fonts/font1.odttf': new Uint8Array(64).fill(0x4f) },
      }),
    ),

  'unstyled-sections.docx': () =>
    build(basePackage({ documentXml: UNSTYLED_SECTIONS, stylesXml: STYLES_BODY, relsXml: BODY_RELS })),

  'lists.docx': () =>
    build(
      basePackage({
        documentXml: LISTS,
        stylesXml: STYLES_LISTS,
        relsXml: LISTS_RELS,
        contentTypesXml: contentTypes(CT_MAIN).replace(
          '</Types>',
          `<Override PartName="/word/numbering.xml" ContentType="${CT_NUMBERING}"/></Types>`,
        ),
        extra: { 'word/numbering.xml': NUMBERING_LISTS },
      }),
    ),

  'tables.docx': () => build(basePackage({ documentXml: TABLES, stylesXml: STYLES_TABLES, relsXml: BODY_RELS })),

  'images.docx': () =>
    build(
      basePackage({
        documentXml: IMAGES,
        stylesXml: STYLES_BODY,
        relsXml: IMAGES_RELS,
        contentTypesXml: contentTypes(CT_MAIN).replace(
          '<Override',
          '<Default Extension="png" ContentType="image/png"/><Default Extension="webp" ContentType="image/webp"/><Override',
        ),
        extra: { 'word/media/image1.png': png(200, 30, 30), 'word/media/image2.png': png(30, 30, 200, 8, 4), 'word/media/image3.webp': WEBP },
      }),
    ),

  'opaque.docx': () =>
    build(
      basePackage({
        documentXml: OPAQUE,
        stylesXml: STYLES_BODY,
        relsXml: OPAQUE_RELS,
        contentTypesXml: contentTypes(CT_MAIN).replace(
          '<Override',
          `<Default Extension="png" ContentType="image/png"/><Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/><Override PartName="/word/footnotes.xml" ContentType="${CT_FOOTNOTES}"/><Override`,
        ),
        extra: {
          'word/footnotes.xml': FOOTNOTES,
          // Not a real OLE container: only the part's presence matters to the reader.
          'word/embeddings/oleObject1.bin': new Uint8Array(32).fill(0x2a),
          'word/media/image1.png': png(200, 30, 30),
        },
      }),
    ),

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
