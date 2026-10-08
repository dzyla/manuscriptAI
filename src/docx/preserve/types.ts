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
  /**
   * How the app's style ids relate to the Word styleIds of the imported package (`StyleDef.id` is the app's, never Word's: a French
   * document's "Heading 1" is `Titre1` in Word and `heading1` here). Kept here, not on `StyleDef`, because the mapping is only
   * meaningful against the original `word/styles.xml` and so has exactly the lifetime of this store and the package it describes
   * (both are detached together when a different document replaces the import). Absent on a store that was not made by `readDocx`.
   * See docs/superpowers/specs/2026-10-07-a2b-writer-contract.md section 10.
   */
  styles?: {
    /** App style id -> the `w:styleId` it came from. Every style the document itself defined is here; a backfilled style is not. */
    wordIdByAppId: Record<string, string>;
    /**
     * App style ids that exist in `DocFormat.styles` but are NOT in the document's `styles.xml` (the preset's built-ins it lacked, and a
     * synthesised `normal`). A writer must not emit these as the document's own styles, and must not assume any Word id for them.
     */
    backfilled: string[];
  };
}

export function emptyPreservationStore(): PreservationStore {
  return { version: 1, blocks: {}, fragments: {}, rels: {} };
}
