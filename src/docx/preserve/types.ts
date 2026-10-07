export const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** A self-contained OOXML fragment: XML with its namespace declarations and relationship deps. */
export interface Fragment {
  xml: string;
  relIds: string[];
  nsDecls: Record<string, string>;
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
