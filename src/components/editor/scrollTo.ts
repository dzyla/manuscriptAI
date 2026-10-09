import type { Editor } from '@tiptap/core';

/**
 * Smoothly scroll the editor's scroll container so `pos` sits `where`: a third of the way down, or near the top.
 * Runs after the editor's own scrollIntoView has had a frame. The 50 ms timer can outlive the editor (the user switches
 * documents or the app unmounts), so it re-checks `isDestroyed`: a destroyed view throws on `coordsAtPos`.
 */
export function scrollEditorTo(editor: Editor, pos: number, where: 'third' | 'top' = 'third'): void {
  setTimeout(() => {
    if (editor.isDestroyed) return;
    const coords = editor.view.coordsAtPos(pos);
    if (!coords) return;
    const dom = editor.view.dom;
    const scrollParent = dom.closest('.overflow-y-auto') || dom.parentElement?.closest('.overflow-y-auto');
    if (!scrollParent) return;
    const rect = scrollParent.getBoundingClientRect();
    const offset = where === 'third' ? scrollParent.clientHeight / 3 : 80;
    const targetY = coords.top - rect.top + scrollParent.scrollTop - offset;
    scrollParent.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
  }, 50);
}

/** Wrap the current DOM selection in a short-lived highlight, then unwrap it. Cosmetic; fails quietly when the range spans elements. */
export function flashSelection(): void {
  setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const span = document.createElement('span');
    span.className = 'accept-flash';
    try {
      range.surroundContents(span);
      setTimeout(() => {
        const parent = span.parentNode;
        if (!parent) return;
        while (span.firstChild) parent.insertBefore(span.firstChild, span);
        parent.removeChild(span);
      }, 1200);
    } catch (_) { /* a selection that spans several elements cannot be wrapped: skip the flash */ }
  }, 50);
}
