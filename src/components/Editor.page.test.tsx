// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import Editor from './Editor';
import type { DocFormat } from '../types';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); layout.restore(); });

const letter: DocFormat = {
  page: { size: 'letter', orientation: 'portrait', marginsIn: { top: 0.5, right: 0.5, bottom: 0.5, left: 0.5 } },
  styles: {}, defaults: { fontFamily: 'Arial', fontSizePt: 11 }, preset: 'nih',
};
const a4: DocFormat = {
  ...letter, preset: 'a4',
  page: { size: 'a4', orientation: 'portrait', marginsIn: { top: 1, right: 1.25, bottom: 1.5, left: 0.75 } },
  defaults: { fontFamily: 'Times New Roman', fontSizePt: 12 },
};

/** jsdom has no layout; stub the three measurements the page code reads. */
const layout = (() => {
  const saved: Array<[string, PropertyDescriptor | undefined]> = [];
  const define = (name: string, get: (el: HTMLElement) => number) => {
    saved.push([name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]);
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get(this: HTMLElement) { return get(this); } });
  };
  return {
    stub(opts: { prose: number; outer: number; offsetTop?: number }) {
      define('clientWidth', el => (el.classList.contains('ProseMirror') ? opts.prose : opts.outer));
      define('offsetTop', () => opts.offsetTop ?? 0);
    },
    restore() {
      for (const [name, d] of saved.splice(0).reverse()) {
        if (d) Object.defineProperty(HTMLElement.prototype, name, d); else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
      }
    },
  };
})();

const props = { suggestions: [], onSuggestionClick: () => {}, onChange: () => {} };
const paras = (n: number) => Array.from({ length: n }, (_, i) => `<p>line ${i}</p>`).join('');

function canvas(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[data-testid="page-canvas"]');
  if (!el) throw new Error('page canvas not rendered');
  return el as HTMLElement;
}

describe('page canvas geometry', () => {
  it('sets width, min-height, all four paddings and font from the document format', () => {
    const { container } = render(<Editor {...props} content="<p>hi</p>" format={a4} />);
    const s = canvas(container).style;
    expect(s.width).toBe('8.27in');
    expect(s.minHeight).toBe('11.69in');
    expect([s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft]).toEqual(['1in', '1.25in', '1.5in', '0.75in']);
    expect(s.fontFamily).toContain('Times New Roman');
    expect(s.fontSize).toBe('12pt');
  });

  it('falls back to the exact NIH preset with no format', () => {
    const { container } = render(<Editor {...props} content="<p>hi</p>" format={null} />);
    const s = canvas(container).style;
    expect(s.width).toBe('8.5in');
    expect(s.minHeight).toBe('11in');
    expect([s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft]).toEqual(['0.5in', '0.5in', '0.5in', '0.5in']);
    expect(s.fontFamily).toContain('Arial');
    expect(s.fontSize).toBe('11pt');
  });

  it('puts the guides layer inside the canvas', () => {
    const { container } = render(<Editor {...props} content="<p>hi</p>" format={letter} />);
    expect(container.querySelector('[data-testid="page-guides"]')).not.toBeNull();
    expect(canvas(container).querySelector('[data-testid="page-guides"]')).not.toBeNull();
    expect(canvas(container).querySelector('.ProseMirror')).not.toBeNull();
  });
});

describe('zoom and fit-to-width', () => {
  it.each([50, 150, 200])('applies zoom %i directly as the canvas zoom when there is room', (z) => {
    layout.stub({ prose: 720, outer: 5000 });
    const { container } = render(<Editor {...props} content="<p>hi</p>" format={letter} editorZoom={z} />);
    expect(canvas(container).style.zoom).toBe(String(z / 100));
  });

  it('reduces the effective zoom when the available width is narrower than the page', () => {
    layout.stub({ prose: 720, outer: 408 }); // 816px page at 408px available = 0.5
    const { container } = render(<Editor {...props} content="<p>hi</p>" format={letter} editorZoom={100} />);
    expect(Number(canvas(container).style.zoom)).toBeCloseTo(0.5, 5);
  });

  it('never exceeds the zoom the user asked for, even in a very wide window', () => {
    layout.stub({ prose: 720, outer: 5000 });
    const { container } = render(<Editor {...props} content="<p>hi</p>" format={letter} editorZoom={75} />);
    expect(canvas(container).style.zoom).toBe('0.75');
  });

  it('leaves the user zoom alone when nothing can be measured (width 0)', () => {
    const { container } = render(<Editor {...props} content="<p>hi</p>" format={letter} editorZoom={100} />);
    expect(canvas(container).style.zoom).toBe('1');
  });
});

describe('page guides', () => {
  beforeEach(() => layout.stub({ prose: 720, outer: 5000, offsetTop: 48 }));

  it('draws one guide per estimated page boundary, labelled and spaced by the format page shape', async () => {
    // 130 one-line paragraphs = 130 lines at 60 lines/page = 3 pages = 2 guides.
    // Pitch = 720px / 7.5in content width x 10in content height = 960px.
    const { container } = render(<Editor {...props} content={paras(130)} format={letter} />);
    await waitFor(() => {
      const guides = Array.from(container.querySelectorAll('[data-testid="page-guides"] > div')) as HTMLElement[];
      expect(guides.map(g => g.style.top)).toEqual(['1008px', '1968px']);
      expect(guides.map(g => g.textContent?.trim())).toEqual(['p. 2', 'p. 3']);
    });
  });

  it('derives the pitch from the format, not from a fixed NIH page', async () => {
    // A4 with these margins: content 6.27in x 9.19in. Pitch = 720 / 6.27 x 9.19.
    const pitch = (720 / 6.27) * 9.19;
    const { container } = render(<Editor {...props} content={paras(130)} format={a4} />);
    await waitFor(() => {
      const first = container.querySelector('[data-testid="page-guides"] > div') as HTMLElement | null;
      expect(first).not.toBeNull();
      expect(parseFloat(first!.style.top)).toBeCloseTo(48 + pitch, 3);
    });
  });

  it('draws no guides for a one-page document', async () => {
    const { container } = render(<Editor {...props} content={paras(5)} format={letter} />);
    await new Promise(r => setTimeout(r, 30));
    expect(container.querySelectorAll('[data-testid="page-guides"] > div')).toHaveLength(0);
  });

  it('draws no guides and does not hang when the margins leave no content width', async () => {
    const none: DocFormat = { ...letter, page: { ...letter.page, marginsIn: { top: 0.5, right: 6, bottom: 0.5, left: 6 } } };
    const { container } = render(<Editor {...props} content={paras(130)} format={none} />);
    await new Promise(r => setTimeout(r, 30));
    expect(container.querySelectorAll('[data-testid="page-guides"] > div')).toHaveLength(0);
  });

  it('caps the guides at 200 however long the document is', async () => {
    // One paragraph estimated at ~210 pages (113 chars x 60 lines x 210).
    const long = `<p>${'x'.repeat(113 * 60 * 210)}</p>`;
    const { container } = render(<Editor {...props} content={long} format={letter} />);
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="page-guides"] > div')).toHaveLength(200);
    }, { timeout: 5000 });
  }, 15000);
});
