import type { Editor } from '@tiptap/core';
import type { DocFormat } from '../../types';
import { createFormat } from '../../services/formatPresets';
import { builtinStyleIds, styleName } from '../panels/format/formatEdit';

export type BlockId = 'normal' | 'heading1' | 'heading2' | 'heading3' | 'quote' | 'bullet' | 'ordered';
export type AlignId = 'left' | 'center' | 'right' | 'justify';

/** The built-in styles the editor can actually apply: a paragraph and three heading levels. (Caption and Bibliography are styles of the document with no editor node of their own.) */
const STYLE_BLOCK: Record<string, BlockId | undefined> = { normal: 'normal', heading1: 'heading1', heading2: 'heading2', heading3: 'heading3' };

const FALLBACK = createFormat('nih');

/**
 * The block list for the selector: the named styles come from BUILTIN_STYLE_IDS (through the Format panel's own `builtinStyleIds`/`styleName`), so it cannot disagree with the
 * Format panel's Styles section; quote and the two list kinds are structure, not named styles, and follow them.
 */
export function blockOptions(format?: DocFormat | null): { id: BlockId; label: string }[] {
  const f = format ?? FALLBACK;
  const styles = builtinStyleIds().flatMap(id => (STYLE_BLOCK[id] ? [{ id: STYLE_BLOCK[id]!, label: styleName(f, id) }] : []));
  return [...styles, { id: 'quote', label: 'Quote' }, { id: 'bullet', label: 'Bullet list' }, { id: 'ordered', label: 'Numbered list' }];
}

export function blockOf(e: Editor): BlockId {
  if (e.isActive('heading', { level: 1 })) return 'heading1';
  if (e.isActive('heading', { level: 2 })) return 'heading2';
  if (e.isActive('heading', { level: 3 })) return 'heading3';
  if (e.isActive('bulletList')) return 'bullet';
  if (e.isActive('orderedList')) return 'ordered';
  if (e.isActive('blockquote')) return 'quote';
  return 'normal';
}

export function alignOf(e: Editor): AlignId {
  for (const a of ['center', 'right', 'justify'] as const) if (e.isActive({ textAlign: a })) return a;
  return 'left';
}

/** Make the block under the selection `id`. Leaving a list or a quote for a paragraph or heading lifts out of it first. */
export function applyBlock(e: Editor, id: BlockId): void {
  const cur = blockOf(e);
  if (cur === id) return;
  let c = e.chain().focus();
  if (id === 'quote') c = c.toggleBlockquote();
  else if (id === 'bullet') c = c.toggleBulletList();
  else if (id === 'ordered') c = c.toggleOrderedList();
  else {
    if (cur === 'bullet') c = c.toggleBulletList();
    else if (cur === 'ordered') c = c.toggleOrderedList();
    else if (cur === 'quote') c = c.toggleBlockquote();
    c = id === 'normal' ? c.setParagraph() : c.setHeading({ level: Number(id.slice(-1)) as 1 | 2 | 3 });
  }
  c.run();
}
