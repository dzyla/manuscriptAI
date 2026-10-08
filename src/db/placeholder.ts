/** The text a brand-new document opens with. A document that is nothing but this (or nothing at all) has no work in it worth a backup. */
export const PLACEHOLDER_TEXT = 'Start writing your manuscript here, or click "New Manuscript" to begin with an IMRAD template.';

const squash = (s: string): string => s.replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

/** True for no text at all, or exactly the placeholder: NOT for text typed into or after the placeholder. */
export function isBlankText(text: string): boolean {
  const t = squash(text);
  return t === '' || t === PLACEHOLDER_TEXT;
}
