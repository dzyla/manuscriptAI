export const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** A self-contained OOXML fragment: XML with its namespace declarations and relationship deps. */
export interface Fragment {
  xml: string;
  relIds: string[];
  nsDecls: Record<string, string>;
  /**
   * Only on a `preservation.blocks` entry: the pictures that were lifted out of this paragraph into image nodes (see
   * docx/read/drawings.ts). `drawingIndex` is the ordinal of the picture among ALL `w:drawing` elements of this `<w:p>`, in document
   * order, which is how a writer finds it in the original XML; `fragmentId` is the image node's `fragmentId`. Blocks are never
   * pruned, so this survives the deletion of the image node, which is what lets a writer see that a lifted picture was removed.
   * See `planLiftedDrawings` (preserve/lifted.ts).
   */
  lifted?: Array<{
    fragmentId: string;
    drawingIndex: number;
    /** `blockHash` of the image node as it was read: an in-place picture whose hash differs has been edited (resized, cropped, re-captioned...). */
    sourceHash?: string;
  }>;
}

export interface PackageRel {
  id: string;
  type: string;
  target: string;
  targetMode?: 'External';
}

/** Per-document preservation data (spec §2.4). Persisted in the docxPackages table. */
export interface PreservationStore {
  version: 1;
  /** blockId → original <w:p>/<w:tbl> XML, for verbatim reuse of untouched blocks */
  blocks: Record<string, Fragment>;
  /** fragmentId → opaque atom XML (equations, footnote refs, SDTs, …) */
  fragments: Record<string, Fragment>;
  /** original document.xml.rels entries, by id */
  rels: Record<string, PackageRel>;
}

export function emptyPreservationStore(): PreservationStore {
  return { version: 1, blocks: {}, fragments: {}, rels: {} };
}
