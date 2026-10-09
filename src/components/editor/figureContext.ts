import type { Editor } from '@tiptap/core';
import { NodeSelection } from 'prosemirror-state';

/**
 * The text around the selected figure, for the figure-AI prompts: the nearest "Figure ..." caption (after the image, else before),
 * else the nearest non-empty paragraph on each side. For a text range that spans a figure, the text in the range. Empty when there is none
 * (a figure with no caption and no neighbours simply gets no context).
 */
export function getImageContext(editor: Editor | null): string {
  if (!editor) return '';
  const sel = editor.state.selection;

  if (sel instanceof NodeSelection) {
    const doc = editor.state.doc;
    const imagePos = sel.from;
    const clickedNode = doc.nodeAt(imagePos);
    if (!clickedNode || clickedNode.type.name !== 'resizableImage') return '';

    let captionBefore = '';
    let captionAfter = '';
    doc.descendants((node, pos) => {
      if (node.type.name !== 'paragraph') return true;
      const text = node.textContent.trim();
      if (!/^figure/i.test(text)) return true;
      if (pos + node.nodeSize <= imagePos) captionBefore = text; // last before the image wins (nearest)
      else if (pos > imagePos && !captionAfter) captionAfter = text; // first after wins (nearest)
      return true;
    });
    const caption = captionAfter || captionBefore;
    if (caption) return caption;

    let preceding = '';
    let following = '';
    doc.descendants((node, pos) => {
      if (node.type.name !== 'paragraph') return true;
      const text = node.textContent.trim();
      if (!text) return true;
      if (pos + node.nodeSize <= imagePos) preceding = text;
      else if (pos > imagePos && !following) following = text;
      return true;
    });
    return [preceding, following].filter(Boolean).join('\n').trim();
  }

  const { from, to } = sel;
  if (from === to) return '';
  const parts: string[] = [];
  editor.state.doc.nodesBetween(from, to, node => {
    if (node.type.name === 'resizableImage') return false;
    if (node.isText && node.text) parts.push(node.text);
    return true;
  });
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
