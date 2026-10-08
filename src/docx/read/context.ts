import type { ImportReport, FeatureKey } from '../fidelity';
import { addWarning, type FidelityCategory } from '../fidelity';
import type { PreservationStore } from '../preserve/types';
import type { DocxPackage } from './package';
import type { NumberingMap } from './numbering';
import type { StylesResult } from './styles';

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
   * The document's numbering definitions. Optional: whoever reads blocks that can hold lists (the body reader, table cells) may
   * set it once up front; `readTable` reads and caches it here when it is not set.
   */
  numbering?: NumberingMap;
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
