import { Node, mergeAttributes } from '@tiptap/core';

/**
 * A hard page break (w:br w:type="page"). It is an INLINE atom, like the run-level element it comes
 * from: a paragraph that contains a break plus text stays one node, so it keeps its original-OOXML
 * provenance and is still re-emitted verbatim while untouched. Splitting such a paragraph into
 * paragraph / break / paragraph would leave no single node that could own the original XML.
 */
export const PageBreakSpec = Node.create({
  name: 'pageBreak',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  parseHTML: () => [{ tag: 'span[data-page-break]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'span',
    mergeAttributes(HTMLAttributes, { 'data-page-break': '', class: 'page-break', contenteditable: 'false' }),
  ],
});
