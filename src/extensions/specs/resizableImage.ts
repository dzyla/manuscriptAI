import { Node, mergeAttributes } from '@tiptap/core';

const numberAttr = (htmlName: string, key: string) => ({
  default: null,
  parseHTML: (el: HTMLElement) => {
    const n = Number(el.getAttribute(htmlName));
    return el.hasAttribute(htmlName) && Number.isFinite(n) ? n : null;
  },
  renderHTML: (attrs: Record<string, unknown>) => (typeof attrs[key] === 'number' ? { [htmlName]: attrs[key] } : {}),
});

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
      /**
       * How a Word image sits in its text: in line with it, floated to one side (square or tight wrap), or on a line of its
       * own. Set by the DOCX reader; an image the author inserts here has none (null).
       */
      wrap: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const w = el.getAttribute('data-wrap');
          return w === 'inline' || w === 'left' || w === 'right' || w === 'block' ? w : null;
        },
        renderHTML: (attrs: Record<string, unknown>) => (attrs.wrap ? { 'data-wrap': attrs.wrap } : {}),
      },
      /**
       * The size Word gave the image, in inches, AS READ (`width` is that as a share of the content width). A resize in the editor
       * changes `width` only: these two go STALE, so a writer must take the size from `width`, not from them. See
       * docx/read/drawings.ts and docx/preserve/lifted.ts.
       */
      widthIn: numberAttr('data-width-in', 'widthIn'),
      heightIn: numberAttr('data-height-in', 'heightIn'),
      /** Word's crop of the picture (`a:srcRect`, percent of each edge); the stored bytes are the whole picture. */
      crop: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          try {
            const v = JSON.parse(el.getAttribute('data-crop') ?? 'null');
            return v && typeof v === 'object' && ['l', 't', 'r', 'b'].every(k => typeof v[k] === 'number') ? v : null;
          } catch {
            return null;
          }
        },
        renderHTML: (attrs: Record<string, unknown>) => (attrs.crop ? { 'data-crop': JSON.stringify(attrs.crop) } : {}),
      },
      /** The preserved `<w:r>` (run properties and the `w:drawing`) the image was read from: a key of `preservation.fragments`. */
      fragmentId: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-fragment-id') ?? '',
        renderHTML: (attrs: Record<string, unknown>) => (attrs.fragmentId ? { 'data-fragment-id': attrs.fragmentId } : {}),
      },
      /**
       * Set when the image was lifted out of a paragraph that has other content (a picture anchored in a paragraph of text):
       * the `ooxml.blockId` of that paragraph, whose original XML still contains the drawing.
       */
      anchorBlockId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-anchor-block-id'),
        renderHTML: (attrs: Record<string, unknown>) => (attrs.anchorBlockId ? { 'data-anchor-block-id': attrs.anchorBlockId } : {}),
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
