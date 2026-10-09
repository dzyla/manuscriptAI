import type { Editor } from '@tiptap/core';
import { NodeSelection } from 'prosemirror-state';

/** What the editor's selection is, in the terms the top bar cares about. */
export type SelectionKind = 'none' | 'text' | 'figure' | 'table';

export interface SelectionInfo {
  kind: SelectionKind;
  /** Words in the selected text (0 when nothing is selected). */
  words: number;
  /** The H2 section the selection starts in, or null. */
  section: string | null;
}

export const NO_SELECTION: SelectionInfo = { kind: 'none', words: 0, section: null };

/**
 * Figure beats table beats text, with one refinement on the table rule: a TEXT range inside a cell is 'text' (the author selected words
 * and wants bold, Polish and the rest); a caret in a cell, or a selection of whole cells, is 'table' (row and column controls).
 * A range that merely spans a figure is 'figure': the figure's own controls apply and the text actions would be aimed at a figure.
 */
export function selectionInfo(editor: Editor | null): SelectionInfo {
  if (!editor || editor.isDestroyed) return NO_SELECTION;
  const { selection, doc } = editor.state;
  const { from, to } = selection;
  const hasRange = from !== to;

  let section: string | null = null;
  doc.nodesBetween(0, from, (node) => {
    if (node.type.name === 'heading' && node.attrs.level === 2) section = node.textContent;
    return true;
  });

  let figure = selection instanceof NodeSelection && selection.node.type.name === 'resizableImage';
  if (!figure && hasRange) doc.nodesBetween(from, to, n => { if (n.type.name === 'resizableImage') { figure = true; return false; } return true; });
  if (figure) return { kind: 'figure', words: 0, section };

  const cellSelection = selection.toJSON().type === 'cell';
  const inCell = editor.isActive('tableCell') || editor.isActive('tableHeader');
  if (cellSelection || (inCell && !hasRange)) return { kind: 'table', words: 0, section };

  if (!hasRange) return { kind: 'none', words: 0, section };
  const text = doc.textBetween(from, to, ' ').trim();
  return { kind: 'text', words: text ? text.split(/\s+/).length : 0, section };
}

export const sameSelection = (a: SelectionInfo, b: SelectionInfo) => a.kind === b.kind && a.words === b.words && a.section === b.section;
