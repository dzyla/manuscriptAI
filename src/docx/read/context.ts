import type { ImportReport, FeatureKey } from '../fidelity';
import { addWarning, type FidelityCategory } from '../fidelity';
import type { PreservationStore } from '../preserve/types';
import type { DocxPackage } from './package';
import type { NumberingMap } from './numbering';
import type { StylesResult } from './styles';
import type { MediaIndex } from './drawings';

/** A binary asset found in the package, committed by the repository only after the author confirms. */
export interface AssetDraft {
  id: string;
  mime: string;
  data: ArrayBuffer;
  sha256: string;
}

export interface ReadContext {
  pkg: DocxPackage;
  styles: StylesResult;
  report: ImportReport;
  preservation: PreservationStore;
  assets: AssetDraft[];
  /**
   * The document's numbering definitions, cached here by `getNumbering(ctx)` (numbering.ts). Every reader that needs them (the
   * body, table cells) goes through that function; do not call `readNumbering` directly or the part is parsed, and warned about, twice.
   */
  numbering?: NumberingMap;
  /**
   * The document's images, loaded and hashed by `prepareMedia` (drawings.ts) before the body is read. The body reader is
   * synchronous and hashing is not, so without it a `w:drawing` is kept as an opaque atom, exactly as before images were read.
   */
  media?: MediaIndex;
  /** The width of the text area in inches (page width less margins); an image's `width` is its share of this. 6.5 when unknown. */
  contentWidthIn?: number;
  /** Unique ids for blocks and fragments. */
  nextId: () => string;
}

/** Add a warning unless an identical one is already present, so a TOC with 200 internal links warns once. */
export function warnOnce(
  report: ImportReport,
  feature: FeatureKey | 'part',
  message: string,
  category: FidelityCategory,
): void {
  if (!report.warnings.some(w => w.feature === feature && w.message === message)) addWarning(report, feature, message, category);
}

/**
 * Log the ids `ctx.nextId` hands out until `stop()`. An abandoned read (a paragraph or table whose content is withdrawn) removes
 * exactly those ids from `preservation.blocks` / `.fragments`, instead of scanning the maps, which would make a document with many
 * paragraphs or tables quadratic. Trackers nest: an inner one calls the outer's wrapper, so the outer sees every id too. Call
 * `stop()` in a `finally`, innermost first.
 */
export function trackIds(ctx: ReadContext): { created: string[]; stop: () => void } {
  const outer = ctx.nextId;
  const created: string[] = [];
  ctx.nextId = () => {
    const id = outer();
    created.push(id);
    return id;
  };
  return { created, stop: () => void (ctx.nextId = outer) };
}
