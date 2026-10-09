import { useEffect, useState, type RefObject } from 'react';
import type { Editor as TipEditor } from '@tiptap/core';
import type { DocFormat } from '../../types';
import { PAGE_SIZES_IN, createFormat } from '../../services/formatPresets';
import { estimatePages, contentWidthIn, contentHeightIn } from '../../services/pagination';

const DEFAULT_FORMAT: DocFormat = createFormat('nih');

/** Guide offsets equal to within a tenth of a pixel. Sub-pixel layout jitter must not count as a change. */
const same = (a: number[], b: number[]): boolean =>
  a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 0.1);

/**
 * The page canvas's two measured numbers: the zoom actually applied (fit to width, never above what was asked) and where the page guides sit.
 * Moved out of Editor.tsx verbatim; Editor.page.test.tsx and the guide-geometry tests pin it.
 */
export function usePageCanvas({ editor, fitRef, pageGuideContainerRef, editorZoom, format, content }: {
  editor: TipEditor | null;
  fitRef: RefObject<HTMLDivElement | null>;
  pageGuideContainerRef: RefObject<HTMLDivElement | null>;
  editorZoom: number;
  format?: DocFormat | null;
  content: string;
}) {
  const canvasFormat = format ?? DEFAULT_FORMAT;
  const [pageGuideOffsets, setPageGuideOffsets] = useState<number[]>([]);
  // Fit-to-width: the zoom actually applied, never above what the user asked for.
  const [effectiveZoom, setEffectiveZoom] = useState(editorZoom / 100);

  // ── Fit to width: effective zoom = min(user zoom, available / page width) ──
  // Still the single CSS `zoom` on the canvas, so the guides stay in the same
  // coordinate frame as the text by construction.
  useEffect(() => {
    const wrap = fitRef.current;
    const avail = wrap?.parentElement;
    const requested = editorZoom / 100;
    const pageWidthPx = PAGE_SIZES_IN[canvasFormat.page.size].width * 96;
    const fit = () => {
      const cs = avail ? getComputedStyle(avail) : null;
      const pad = cs ? (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) : 0;
      const width = avail ? avail.clientWidth - pad : 0;
      // 0 means unmeasured (no layout): leave the user's zoom alone.
      setEffectiveZoom(width > 0 ? Math.max(0.1, Math.min(requested, width / pageWidthPx)) : requested);
    };
    fit();
    if (typeof ResizeObserver === 'undefined' || !avail) return;
    const ro = new ResizeObserver(fit);
    ro.observe(avail);
    return () => ro.disconnect();
  }, [editorZoom, canvasFormat.page.size]);

  // ── Page guides ──────────────────────────────────────────────────────────
  // HOW MANY guides, and their "p. N" labels, come from estimatePages (the one
  // page-number source). WHERE each sits is DOM-measured: the page pitch is the
  // rendered content width scaled by the format's page shape. Zoom-invariant,
  // since measurement and guides share the zoomed canvas's coordinate frame.
  useEffect(() => {
    const el = pageGuideContainerRef.current;
    if (!el) return;
    const compute = () => {
      const prose = el.querySelector('.ProseMirror') as HTMLElement | null;
      if (!prose) return;
      const widthIn = contentWidthIn(format ?? null);
      if (widthIn <= 0) return;
      const pageHeight = (prose.clientWidth / widthIn) * contentHeightIn(format ?? null);
      if (pageHeight < 100) { setPageGuideOffsets([]); return; }
      const n = estimatePages(editor?.getJSON(), format ?? null).pages - 1;
      const contentTop = prose.offsetTop;
      const next = Array.from({ length: Math.min(n, 200) }, (_, i) => contentTop + (i + 1) * pageHeight);
      // Set state only when the numbers actually moved. A fresh array on every
      // observation re-renders the guides, which lays out, which re-fires this
      // ResizeObserver: typing a paragraph long enough to add a scrollbar shifts
      // prose.clientWidth ~15px, changing the pitch, and React only stops at its
      // 50-update limit ("Maximum update depth exceeded"). Rounding to a tenth of
      // a pixel keeps sub-pixel layout jitter from restarting the same loop.
      setPageGuideOffsets(prev => same(prev, next) ? prev : next);
    };
    compute();
    // Absent in jsdom and very old webviews; the guides then just measure once per content change.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(compute);
    const prose = el.querySelector('.ProseMirror');
    if (prose) ro.observe(prose);
    return () => ro.disconnect();
  }, [format, content, editor, effectiveZoom]);

  return { effectiveZoom, pageGuideOffsets };
}
