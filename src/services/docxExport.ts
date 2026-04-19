// src/services/docxExport.ts
import {
  Document, Paragraph, TextRun, HeadingLevel, ImageRun,
  Table, TableRow, TableCell, WidthType, AlignmentType,
  LevelFormat, Packer, FileChild,
} from 'docx';
import type { ASTRenderer, Marks, ImageMeta } from './astExport';

export { Packer };

const ORDERED_LIST_REF = 'ordered-list-1';

function getDocxImageType(mimeType: string): 'jpg' | 'png' | 'gif' | 'bmp' | null {
  if (mimeType.includes('jpeg')) return 'jpg';
  if (mimeType.includes('png'))  return 'png';
  if (mimeType.includes('gif'))  return 'gif';
  if (mimeType.includes('bmp'))  return 'bmp';
  return null; // unsupported (e.g. webp)
}

export class DocxRenderer implements ASTRenderer {
  private title: string;

  constructor(opts: { title: string; images: Map<string, ImageMeta> }) {
    this.title = opts.title;
  }

  doc(children: unknown[]): Document {
    // Flatten arrays produced by bulletList/orderedList
    const blocks: FileChild[] = [];
    for (const child of children) {
      if (Array.isArray(child)) {
        for (const item of child as unknown[]) {
          if (item instanceof FileChild) blocks.push(item);
        }
      } else if (child instanceof FileChild) {
        blocks.push(child);
      } else if (child != null) {
        // Unknown inline leaked into block position — wrap it safely
        blocks.push(new Paragraph({ children: [child as TextRun] }));
      }
    }
    return new Document({
      title: this.title,
      numbering: {
        config: [{
          reference: ORDERED_LIST_REF,
          levels: [{
            level: 0,
            format: LevelFormat.DECIMAL,
            text: '%1.',
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } },
          }],
        }],
      },
      sections: [{ children: blocks }],
    });
  }

  heading(level: 1 | 2 | 3, inlines: unknown[]): Paragraph {
    const map = {
      1: HeadingLevel.HEADING_1,
      2: HeadingLevel.HEADING_2,
      3: HeadingLevel.HEADING_3,
    } as const;
    return new Paragraph({
      heading: map[level],
      children: inlines as TextRun[],
    });
  }

  paragraph(inlines: unknown[]): Paragraph {
    return new Paragraph({ children: inlines as TextRun[] });
  }

  text(content: string, marks: Marks): TextRun {
    return new TextRun({
      text: content,
      bold: marks.bold,
      italics: marks.italic,
      underline: marks.underline ? {} : undefined,
      font: marks.code ? 'Courier New' : undefined,
      strike: marks.strike,
    });
  }

  citationNode(nums: number[]): TextRun {
    if (nums.length === 0) return new TextRun({ text: '[?]' });
    const sorted = [...nums].sort((a, b) => a - b);
    if (sorted.length === 1) return new TextRun({ text: `[${sorted[0]}]` });
    const isConsecutive = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
    const label = isConsecutive
      ? `[${sorted[0]}–${sorted[sorted.length - 1]}]`
      : `[${sorted.join(',')}]`;
    return new TextRun({ text: label });
  }

  hardBreak(): TextRun {
    return new TextRun({ break: 1 });
  }

  bulletList(items: unknown[][]): Paragraph[] {
    return items.map(inlines =>
      new Paragraph({
        bullet: { level: 0 },
        children: inlines as TextRun[],
      })
    );
  }

  orderedList(items: unknown[][]): Paragraph[] {
    return items.map(inlines =>
      new Paragraph({
        numbering: { reference: ORDERED_LIST_REF, level: 0 },
        children: inlines as TextRun[],
      })
    );
  }

  resizableImage(src: string, _alt: string, widthAttr: string, meta?: ImageMeta): Paragraph {
    if (!meta?.buffer || meta.buffer.byteLength === 0) {
      return new Paragraph({ children: [new TextRun({ text: '[image]', italics: true })] });
    }
    // Parse width attr (e.g. "400px", "100%") → pixel width capped at 600
    const parsedPx = parseInt(widthAttr);
    const displayWidth = (!isNaN(parsedPx) && parsedPx > 0 && !widthAttr.includes('%'))
      ? Math.min(parsedPx, 600)
      : 500;
    const aspectRatio = (meta.height > 0 && meta.width > 0) ? meta.height / meta.width : 0.75;
    const displayHeight = Math.round(displayWidth * aspectRatio);
    const docxType = getDocxImageType(meta.mimeType);
    if (!docxType) {
      return new Paragraph({ children: [new TextRun({ text: '[image — unsupported format for Word export (convert to PNG/JPG)]', italics: true })] });
    }

    return new Paragraph({
      children: [
        new ImageRun({
          type: docxType,
          data: new Uint8Array(meta.buffer),
          transformation: { width: displayWidth, height: displayHeight },
        }),
      ],
    });
  }

  table(rows: unknown[][][]): Table {
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: rows.map(cells =>
        new TableRow({
          children: cells.map(inlines =>
            new TableCell({
              children: [new Paragraph({ children: inlines as TextRun[] })],
            })
          ),
        })
      ),
    });
  }
}
