import { generateHTML, generateJSON, getSchema, type Extensions, type JSONContent } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { getSpecExtensions } from './schemaSpecs';
import { ResizableImageView } from './views/ResizableImageView';
import { CitationView } from './views/CitationView';
import { FigureLabelView } from './views/FigureLabelView';

const VIEWS: Record<string, () => unknown> = {
  resizableImage: () => ReactNodeViewRenderer(ResizableImageView),
  citation: () => ReactNodeViewRenderer(CitationView),
  figureLabel: () => ReactNodeViewRenderer(FigureLabelView),
};

/**
 * The editor schema: the pure specs (schemaSpecs.ts) plus their React node views.
 * Interactive-only extensions (placeholder, autocomplete, grammar) are added by Editor.tsx.
 */
export function getSchemaExtensions(): Extensions {
  return getSpecExtensions().map(ext => {
    const name = (ext as { name?: string }).name ?? '';
    const view = VIEWS[name];
    return view
      ? (ext as unknown as { extend: (c: object) => Extensions[number] }).extend({ addNodeView: view })
      : ext;
  });
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
