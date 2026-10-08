import { Node, mergeAttributes } from '@tiptap/core';

export const ResizableImageSpec = Node.create({
  name: 'resizableImage',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      src:   { default: null },
      alt:   { default: '' },
      title: { default: '' },
      width: {
        default: '100%',
        parseHTML: (el: HTMLElement) => el.style.width || el.getAttribute('width') || '100%',
      },
      align: {
        default: 'center',
        parseHTML: (el: HTMLElement) => {
          const a = el.getAttribute('data-align');
          return a === 'left' || a === 'center' || a === 'right' ? a : 'center';
        },
      },
      assetId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-asset-id'),
        renderHTML: (attrs: Record<string, unknown>) => (attrs.assetId ? { 'data-asset-id': attrs.assetId } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'img[src]' }, { tag: 'img[data-asset-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const { align, width, ...rest } = HTMLAttributes;
    const style = [
      width ? `width:${width}` : '',
      align === 'left'  ? 'margin-right:auto;margin-left:0' :
      align === 'right' ? 'margin-left:auto;margin-right:0' :
      'margin-left:auto;margin-right:auto',
    ].filter(Boolean).join(';');
    return ['img', mergeAttributes(rest, { style, 'data-align': align })];
  },

  addCommands() {
    return {
      insertResizableImage: (attrs: { src: string; alt?: string; width?: string; align?: string }) =>
        ({ commands }: any) => {
          return commands.insertContent({ type: this.name, attrs });
        },
    } as any;
  },
});
