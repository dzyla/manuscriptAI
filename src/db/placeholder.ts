import type { JSONContent } from '@tiptap/core';

/** The text a brand-new document opens with. A document that is nothing but this (or nothing at all) has no work in it worth a backup. */
export const PLACEHOLDER_TEXT = 'Start writing your manuscript here, or click "New Manuscript" to begin with an IMRAD template.';

const squash = (s: string): string => s.replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

/** True for no text at all, or exactly the placeholder: NOT for text typed into or after the placeholder. */
export function isBlankText(text: string): boolean {
  const t = squash(text);
  return t === '' || t === PLACEHOLDER_TEXT;
}

/**
 * True for a document with no text (or only the placeholder) AND no content that is not text: an image, a line break, a rule, a
 * citation, a preserved piece... Any node other than the document, a paragraph, a heading or text counts as content (an empty table or list too). This is THE blank test:
 * the repository (is a replaced document worth a backup slot), the snapshot before an import and the "replace the open document?"
 * prompts all go through it, so a figures-only document is never called empty by one and not by another.
 */
export function isBlankDoc(doc: JSONContent): boolean {
  const parts: string[] = [];
  const walk = (n: JSONContent): void => {
    if (n.type === 'text') parts.push(n.text ?? '');
    else if (n.type && n.type !== 'doc' && n.type !== 'paragraph' && n.type !== 'heading') parts.push('\u0000'); // a table, list, image, break, rule, citation, preserved piece...
    n.content?.forEach(walk);
  };
  walk(doc);
  return isBlankText(parts.join(''));
}
