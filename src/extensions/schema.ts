import { generateHTML, generateJSON, getSchema, type Extensions, type JSONContent } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import { TableKit } from '@tiptap/extension-table';
import { ResizableImage } from './ResizableImage';
import { CitationNode } from './CitationNode';
import { FigureLabel } from './FigureLabel';
import { OoxmlProvenance } from './preserve/OoxmlProvenance';

/**
 * The document schema, shared by the live editor and headless conversion.
 * Interactive-only extensions (placeholder, autocomplete, grammar) are added by Editor.tsx.
 */
export function getSchemaExtensions(): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false },
    }),
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    TableKit.configure({ table: { resizable: true } }),
    ResizableImage,
    CitationNode,
    FigureLabel,
    OoxmlProvenance,
  ];
}

let schemaCache: Schema | null = null;
let extCache: Extensions | null = null;

function exts(): Extensions {
  if (!extCache) extCache = getSchemaExtensions();
  return extCache;
}

export function getDocSchema(): Schema {
  if (!schemaCache) schemaCache = getSchema(exts());
  return schemaCache;
}

/** Parse HTML into canonical document JSON. Needs a DOM (browser or jsdom). */
export function htmlToDoc(html: string): JSONContent {
  return normalizeDoc(generateJSON(html, exts()) as JSONContent);
}

export function docToHtml(doc: JSONContent): string {
  return generateHTML(doc, exts());
}

/** Round-trip through the ProseMirror schema: fills defaults, canonical mark order. Throws if invalid. */
export function normalizeDoc(doc: JSONContent): JSONContent {
  const node = getDocSchema().nodeFromJSON(doc);
  node.check();
  return node.toJSON() as JSONContent;
}

export function isValidDoc(doc: unknown): doc is JSONContent {
  if (!doc || typeof doc !== 'object' || (doc as JSONContent).type !== 'doc') return false;
  try {
    normalizeDoc(doc as JSONContent);
    return true;
  } catch {
    return false;
  }
}
