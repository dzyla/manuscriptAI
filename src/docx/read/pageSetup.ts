/**
 * Page size and margins from the body's final w:sectPr. The app models one page setup per
 * document, so earlier sections (a w:sectPr inside a paragraph's w:pPr) are only counted; the
 * paragraphs that carry them are preserved verbatim by the body reader.
 *
 * WRITER: this captures ONLY the page size, orientation (as a warning) and the four margins. The body's `w:sectPr` also holds the
 * gutter, column layout, `titlePg` (different first page), header and footer references, `pgNumType` (page-number format and start),
 * `w:type`, line numbering and page borders, none of which the model holds and none of which is stored anywhere else. They survive an
 * export ONLY if the writer keeps the ORIGINAL body `sectPr` from the package (changing at most its `pgSz` / `pgMar` when
 * `DocFormat.page` was edited) rather than writing a fresh one from `DocFormat.page`. The header and footer relationship ids it
 * references are the ones `preservation.rels` stores for it. See docs/superpowers/specs/2026-10-07-a2b-writer-contract.md section 11.
 */
import type { PageSetup } from '../../types';
import { PAGE_SIZES_IN } from '../../services/formatPresets';
import { FIDELITY, recordFeature, type ImportReport } from '../fidelity';
import { twipsToIn } from './units';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
/** Word's own defaults when a section carries no size or margins. */
const DEFAULT_MARGIN_IN = 1;
const SIZE_TOLERANCE_IN = 0.05;

function twips(el: Element | undefined, name: string): number | undefined {
  if (!el || !el.hasAttributeNS(W, name)) return undefined;
  const raw = el.getAttributeNS(W, name).trim();
  if (!/^-?\d+$/.test(raw)) return undefined;
  return Number(raw);
}

function firstChild(parent: Element, local: string): Element | undefined {
  for (let c = parent.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1 && (c as Element).namespaceURI === W && (c as Element).localName === local) return c as Element;
  }
  return undefined;
}

function warn(report: ImportReport | undefined, message: string): void {
  report?.warnings.push({ feature: 'pageSetup', category: FIDELITY.pageSetup, message });
}

function paperSize(sectPr: Element | undefined, report?: ImportReport): PageSetup['size'] {
  const pgSz = sectPr && firstChild(sectPr, 'pgSz');
  const w = twips(pgSz, 'w');
  const h = twips(pgSz, 'h');
  if (!pgSz) return 'letter';
  if (w === undefined || h === undefined || w <= 0 || h <= 0) {
    warn(report, 'The page size could not be read; US Letter is assumed.');
    return 'letter';
  }
  const landscape = pgSz.getAttributeNS(W, 'orient') === 'landscape' || w > h;
  if (landscape) warn(report, 'Landscape pages are not supported yet; the page is treated as portrait.');
  const short = twipsToIn(Math.min(w, h));
  const long = twipsToIn(Math.max(w, h));
  let best: PageSetup['size'] = 'letter';
  let bestDist = Infinity;
  for (const [name, dim] of Object.entries(PAGE_SIZES_IN) as Array<[PageSetup['size'], { width: number; height: number }]>) {
    const dShort = Math.abs(short - dim.width);
    const dLong = Math.abs(long - dim.height);
    if (dShort <= SIZE_TOLERANCE_IN && dLong <= SIZE_TOLERANCE_IN) return name;
    if (dShort + dLong < bestDist) {
      bestDist = dShort + dLong;
      best = name;
    }
  }
  warn(report, `The page size (${short.toFixed(2)} x ${long.toFixed(2)} in) is not US Letter or A4; ${best === 'a4' ? 'A4' : 'US Letter'} is used.`);
  return best;
}

export function readPageSetup(body: Element, report?: ImportReport): { page: PageSetup; extraSections: number } {
  let sectPr: Element | undefined;
  for (let c = body.lastChild; c; c = c.previousSibling) {
    if (c.nodeType === 1 && (c as Element).namespaceURI === W && (c as Element).localName === 'sectPr') {
      sectPr = c as Element;
      break;
    }
  }

  const pgMar = sectPr && firstChild(sectPr, 'pgMar');
  const margin = (name: string): number => {
    const t = twips(pgMar, name);
    return t === undefined ? DEFAULT_MARGIN_IN : Math.max(0, twipsToIn(t));
  };
  const page: PageSetup = {
    size: paperSize(sectPr, report),
    orientation: 'portrait',
    marginsIn: { top: margin('top'), right: margin('right'), bottom: margin('bottom'), left: margin('left') },
  };

  // Earlier sections: a sectPr directly inside a paragraph's own pPr (not inside a tracked pPrChange).
  let extraSections = 0;
  const all = body.getElementsByTagNameNS(W, 'sectPr');
  for (let i = 0; i < all.length; i++) {
    const pPr = all[i].parentNode;
    if (pPr && pPr.nodeType === 1 && (pPr as Element).localName === 'pPr' && pPr.parentNode && (pPr.parentNode as Element).localName === 'p') {
      extraSections++;
    }
  }
  if (report) recordFeature(report, 'pageSetup');
  return { page, extraSections };
}
