// src/services/docxExport.ts
import {
  Document, Paragraph, TextRun, HeadingLevel, ImageRun,
  Table, TableRow, TableCell, WidthType, AlignmentType,
  LevelFormat, Packer,
} from 'docx';
import type { ASTRenderer, Marks, ImageMeta } from './astExport';

export { Packer };

const ORDERED_LIST_REF = 'ordered-list-1';

export class DocxRenderer implements ASTRenderer {
  private title: string;
  private images: Map<string, ImageMeta>;

  constructor(opts: { title: string; images: Map<string, ImageMeta> }) {
    this.title = opts.title;
    this.images = opts.images;
  }

  doc(children: unknown[]): Document {
    // Flatten arrays produced by bulletList/orderedList
    const blocks: (Paragraph | Table)[] = [];
    for (const child of children) {
      if (Array.isArray(child)) {
        blocks.push(...(child as (Paragraph | Table)[]));
      } else if (child != null) {
        blocks.push(child as Paragraph | Table);
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
    const label = nums.length === 0 ? '[?]'
      : nums.length === 1 ? `[${nums[0]}]`
      : `[${nums[0]}–${nums[nums.length - 1]}]`;
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
    const aspectRatio = meta.height > 0 ? meta.height / meta.width : 0.75;
    const displayHeight = Math.round(displayWidth * aspectRatio);
    const ext = meta.mimeType.includes('jpeg') ? 'jpg' : 'png';

    return new Paragraph({
      children: [
        new ImageRun({
          type: ext,
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
