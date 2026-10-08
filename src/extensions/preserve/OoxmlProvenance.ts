import { Extension } from '@tiptap/core';

/** Block types that can carry original-OOXML provenance (spec §2.4). */
export const PROVENANCE_NODE_TYPES = [
  'paragraph', 'heading', 'table', 'bulletList', 'orderedList', 'blockquote', 'opaqueBlock',
  // an image that stands for a whole Word paragraph (a figure on its own line) owns that paragraph's original XML
  'resizableImage',
];

export interface OoxmlProvenanceAttr {
  blockId: string;
  sourceHash: string;
  /** Tables only: `structureHash` of the table as imported (see docx/preserve/hash.ts). */
  structureHash?: string;
}

function parseProvenance(raw: string | null): OoxmlProvenanceAttr | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v.blockId === 'string' && typeof v.sourceHash === 'string'
      ? { blockId: v.blockId, sourceHash: v.sourceHash, ...(typeof v.structureHash === 'string' ? { structureHash: v.structureHash } : {}) }
      : null;
  } catch {
    return null;
  }
}

export const OoxmlProvenance = Extension.create({
  name: 'ooxmlProvenance',
  addGlobalAttributes() {
    return [
      {
        types: PROVENANCE_NODE_TYPES,
        attributes: {
          ooxml: {
            default: null,
            // keepOnSplit:false only affects the *new* block created at the end of a block. A mid-block
            // (or start-of-block) split copies the attrs to both halves, so it does NOT on its own prevent
            // two blocks from carrying the same ooxml provenance. Uniqueness is enforced by
            // OpaqueFragmentGuard, which clears duplicated provenance in an appendTransaction.
            keepOnSplit: false,
            parseHTML: (el: HTMLElement) => parseProvenance(el.getAttribute('data-ooxml')),
            renderHTML: (attrs: Record<string, unknown>) =>
              attrs.ooxml ? { 'data-ooxml': JSON.stringify(attrs.ooxml) } : {},
          },
        },
      },
    ];
  },
});
