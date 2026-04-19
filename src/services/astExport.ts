// src/services/astExport.ts

export interface Marks {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  code?: boolean;
  strike?: boolean;
}

export interface PmNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string }>;
  content?: PmNode[];
}

export interface ImageMeta {
  buffer: ArrayBuffer;
  width: number;
  height: number;
  mimeType: string;
}

// ASTRenderer: implement one method per ProseMirror node type.
// Return type is unknown at the interface level — each renderer uses its own
// concrete types internally (e.g. docx.Paragraph, string).
export interface ASTRenderer {
  // block-level (children of doc)
  doc(children: unknown[]): unknown;
  heading(level: 1 | 2 | 3, inlines: unknown[]): unknown;
  paragraph(inlines: unknown[]): unknown;
  bulletList(items: unknown[][]): unknown;
  orderedList(items: unknown[][]): unknown;
  resizableImage(src: string, alt: string, width: string, meta?: ImageMeta): unknown;
  table(rows: unknown[][][]): unknown;
  // inline-level (children of block nodes)
  text(content: string, marks: Marks): unknown;
  citationNode(nums: number[]): unknown;
  hardBreak(): unknown;
}

// Resolves all resizableImage srcs to ArrayBuffers + dimensions before the walk.
export async function prefetchImages(root: PmNode): Promise<Map<string, ImageMeta>> {
  const srcs = new Set<string>();
  function collect(node: PmNode) {
    if (node.type === 'resizableImage' && typeof node.attrs?.src === 'string') {
      srcs.add(node.attrs.src as string);
    }
    node.content?.forEach(collect);
  }
  collect(root);

  const map = new Map<string, ImageMeta>();
  await Promise.all([...srcs].map(async (src) => {
    try {
      let buffer: ArrayBuffer;
      let mimeType = 'image/png';
      if (src.startsWith('data:')) {
        const [header, base64] = src.split(',');
        mimeType = header.match(/:(.*?);/)?.[1] ?? 'image/png';
        const binary = atob(base64);
        buffer = new ArrayBuffer(binary.length);
        const view = new Uint8Array(buffer);
        for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
      } else {
        const res = await fetch(src);
        buffer = await res.arrayBuffer();
        mimeType = res.headers.get('content-type') ?? 'image/png';
      }
      const { width, height } = await getImageDimensions(src);
      map.set(src, { buffer, width, height, mimeType });
    } catch {
      // skip unresolvable images
    }
  }));
  return map;
}

function getImageDimensions(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 400, height: img.naturalHeight || 300 });
    img.onerror = () => resolve({ width: 400, height: 300 });
    img.src = src;
  });
}

function parseMarks(marks?: Array<{ type: string }>): Marks {
  const m: Marks = {};
  for (const mark of marks ?? []) {
    if (mark.type === 'bold')      m.bold      = true;
    if (mark.type === 'italic')    m.italic    = true;
    if (mark.type === 'underline') m.underline = true;
    if (mark.type === 'code')      m.code      = true;
    if (mark.type === 'strike')    m.strike    = true;
  }
  return m;
}

export function walkNode(node: PmNode, r: ASTRenderer, images?: Map<string, ImageMeta>): unknown {
  switch (node.type) {
    case 'doc':
      return r.doc((node.content ?? []).map(c => walkNode(c, r, images)));

    case 'heading':
      return r.heading(
        (node.attrs?.level as 1 | 2 | 3) ?? 1,
        (node.content ?? []).map(c => walkNode(c, r, images))
      );

    case 'paragraph':
      return r.paragraph((node.content ?? []).map(c => walkNode(c, r, images)));

    case 'bulletList':
      return r.bulletList(
        (node.content ?? []).map(li => {
          const paras = (li.content ?? []).filter(c => c.type === 'paragraph');
          return paras.flatMap(p => (p.content ?? []).map(c => walkNode(c, r, images)));
        })
      );

    case 'orderedList':
      return r.orderedList(
        (node.content ?? []).map(li => {
          const paras = (li.content ?? []).filter(c => c.type === 'paragraph');
          return paras.flatMap(p => (p.content ?? []).map(c => walkNode(c, r, images)));
        })
      );

    case 'resizableImage': {
      const src = (node.attrs?.src as string) ?? '';
      return r.resizableImage(
        src,
        (node.attrs?.alt as string) ?? '',
        (node.attrs?.width as string) ?? '100%',
        images?.get(src)
      );
    }

    case 'table':
      return r.table(
        (node.content ?? []).map(row =>       // tableRow
          (row.content ?? []).map(cell =>     // tableCell / tableHeader
            (cell.content ?? []).flatMap(block =>  // paragraph blocks within cell
              (block.content ?? []).map(inline => walkNode(inline, r, images))
            )
          )
        )
      );

    case 'blockquote':
      return r.paragraph((node.content ?? []).flatMap(para =>
        (para.content ?? []).map(c => walkNode(c, r, images))
      ));

    case 'text':
      return r.text(node.text ?? '', parseMarks(node.marks));

    case 'citation':
      return r.citationNode((node.attrs?.nums as number[]) ?? []);

    case 'hardBreak':
      return r.hardBreak();

    case 'figureLabel':
      return r.text(`Figure ${(node.attrs?.num as number) ?? '?'}`, {});

    default:
      console.warn(`astExport: unknown node type "${node.type}", falling back to text`);
      return r.text(
        (node.content ?? []).map(c => c.text ?? '').join(''),
        {}
      );
  }
}
