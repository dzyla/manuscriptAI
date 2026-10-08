import { generateJSON, getSchema, type Extensions, type JSONContent } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import { TableKit } from '@tiptap/extension-table';
import { ResizableImageSpec } from './specs/resizableImage';
import { CitationSpec } from './specs/citation';
import { FigureLabelSpec } from './specs/figureLabel';
import { PageBreakSpec } from './specs/pageBreak';
import { ParagraphFormat } from './specs/paragraphFormat';
import {
  FontFamilyMark, FontSizeMark, TextColorMark, SuperscriptMark, SubscriptMark, CharacterStyleMark,
} from './specs/runMarks';
import { OpaqueInline, OpaqueBlock } from './preserve/OpaqueNodes';
import { OoxmlProvenance } from './preserve/OoxmlProvenance';
import { WordNumbering } from './preserve/WordNumbering';

/**
 * The document schema with no node views: safe to import from a Web Worker or
 * from Node. The editor's own list (src/extensions/schema.ts) extends these.
 */
export function getSpecExtensions(): Extensions {
  return [
    StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false } }),
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    TableKit.configure({ table: { resizable: true } }),
    ResizableImageSpec,
    CitationSpec,
    FigureLabelSpec,
    PageBreakSpec,
    ParagraphFormat,
    FontFamilyMark,
    FontSizeMark,
    TextColorMark,
    SuperscriptMark,
    SubscriptMark,
    CharacterStyleMark,
    OpaqueInline,
    OpaqueBlock,
    OoxmlProvenance,
    WordNumbering,
  ];
}

let schemaCache: Schema | null = null;

export function getSpecSchema(): Schema {
  if (!schemaCache) schemaCache = getSchema(getSpecExtensions());
  return schemaCache;
}

/** Round-trip any node (not just a doc) through the schema: fills attribute defaults, merges adjacent text, orders marks. Throws if invalid. */
export function specNormalizeNode(json: JSONContent): JSONContent {
  const node = getSpecSchema().nodeFromJSON(json);
  node.check();
  return node.toJSON() as JSONContent;
}

export function specNormalizeDoc(doc: JSONContent): JSONContent {
  return specNormalizeNode(doc);
}

/** Needs a DOM (jsdom in tests); the worker path builds JSON directly instead. */
export function specHtmlToDoc(html: string): JSONContent {
  return specNormalizeDoc(generateJSON(html, getSpecExtensions()) as JSONContent);
}
