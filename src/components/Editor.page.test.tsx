// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import Editor from './Editor';
import type { DocFormat } from '../types';

afterEach(cleanup);

beforeAll(() => {
  // jsdom has no ResizeObserver; the page-guide measurement needs one.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});

const letter: DocFormat = {
  page: { size: 'letter', orientation: 'portrait', marginsIn: { top: 0.5, right: 0.5, bottom: 0.5, left: 0.5 } },
  styles: {}, defaults: { fontFamily: 'Arial', fontSizePt: 11 }, preset: 'nih',
};

function canvas(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[data-testid="page-canvas"]');
  if (!el) throw new Error('page canvas not rendered');
  return el as HTMLElement;
}

describe('page canvas geometry', () => {
  it('sets its width and padding from the document format, not from a view setting', () => {
    const { container } = render(<Editor suggestions={[]} onSuggestionClick={() => {}} content="<p>hi</p>" onChange={() => {}} format={letter} />);
    const style = canvas(container).style;
    expect(style.width).toBe('8.5in');
    expect(style.paddingLeft).toBe('0.5in');
    expect(style.paddingTop).toBe('0.5in');
  });

  it("uses the format's body font and size", () => {
    const { container } = render(<Editor suggestions={[]} onSuggestionClick={() => {}} content="<p>hi</p>" onChange={() => {}} format={letter} />);
    const style = canvas(container).style;
    expect(style.fontFamily).toContain('Arial');
    expect(style.fontSize).toBe('11pt');
  });

  it('renders a page-like canvas even with no format at all', () => {
    const { container } = render(<Editor suggestions={[]} onSuggestionClick={() => {}} content="<p>hi</p>" onChange={() => {}} format={null} />);
    expect(canvas(container).style.width).toMatch(/in$/);
  });

  it('shows page guides without requiring grant mode', () => {
    const { container } = render(<Editor suggestions={[]} onSuggestionClick={() => {}} content="<p>hi</p>" onChange={() => {}} format={letter} />);
    expect(container.querySelector('[data-testid="page-guides"]')).not.toBeNull();
  });

  it('keeps guides inside the canvas so zoom scales them with the text', () => {
    const { container } = render(<Editor suggestions={[]} onSuggestionClick={() => {}} content="<p>hi</p>" onChange={() => {}} format={letter} editorZoom={150} />);
    expect(canvas(container).querySelector('[data-testid="page-guides"]')).not.toBeNull();
  });

  it.each([50, 200])('applies zoom %i to the canvas itself, the element holding both text and guides', (z) => {
    const { container } = render(<Editor suggestions={[]} onSuggestionClick={() => {}} content="<p>hi</p>" onChange={() => {}} format={letter} editorZoom={z} />);
    // jsdom discards the CSS `zoom` property, so the canvas also mirrors it as data-zoom.
    const c = canvas(container);
    expect(c.getAttribute('data-zoom')).toBe(String(z));
    expect(c.querySelector('[data-testid="page-guides"]')).not.toBeNull();
    expect(c.querySelector('.ProseMirror')).not.toBeNull();
  });
});
