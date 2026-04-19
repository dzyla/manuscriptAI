// src/services/latexExport.ts
import JSZip from 'jszip';
import type { ASTRenderer, Marks, ImageMeta } from './astExport';

const ESC_MAP: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '&':  '\\&',
  '%':  '\\%',
  '$':  '\\$',
  '#':  '\\#',
  '_':  '\\_',
  '{':  '\\{',
  '}':  '\\}',
  '~':  '\\textasciitilde{}',
  '^':  '\\textasciicircum{}',
};

function esc(s: string): string {
  return s.replace(/[\\&%$#_{}~^]/g, ch => ESC_MAP[ch]);
}

export class LatexRenderer implements ASTRenderer {
  private title: string;
  private zip: JSZip;
  private figureIndex = 0;

  constructor(opts: { title: string; images: Map<string, ImageMeta> }) {
    this.title = opts.title;
    this.zip = new JSZip();
  }

  doc(children: unknown[]): JSZip {
    const body = (children as string[]).filter(Boolean).join('\n\n');
    const hasFigures = this.figureIndex > 0;
    const preamble = [
      `\\documentclass[12pt]{article}`,
      `\\usepackage[margin=1in]{geometry}`,
      `\\usepackage{graphicx}`,
      `\\usepackage{amsmath}`,
      `\\usepackage{ulem}`,
      `\\usepackage{hyperref}`,
      hasFigures ? `% Place the extracted figures/ folder next to this .tex file before compiling.` : '',
      `\\title{${esc(this.title)}}`,
      `\\author{}`,
      `\\date{}`,
      `\\begin{document}`,
      `\\maketitle`,
    ].filter(Boolean).join('\n');

    this.zip.file('manuscript.tex', `${preamble}\n\n${body}\n\n\\end{document}\n`);
    return this.zip;
  }

  heading(level: 1 | 2 | 3, inlines: unknown[]): string {
    const cmd = ['\\section', '\\subsection', '\\subsubsection'][level - 1];
    return `${cmd}{${(inlines as string[]).join('')}}`;
  }

  paragraph(inlines: unknown[]): string {
    return (inlines as string[]).join('');
  }

  text(content: string, marks: Marks): string {
    let s = esc(content);
    if (marks.code)      s = `\\texttt{${s}}`;
    if (marks.bold)      s = `\\textbf{${s}}`;
    if (marks.italic)    s = `\\textit{${s}}`;
    if (marks.underline) s = `\\underline{${s}}`;
    if (marks.strike)    s = `\\sout{${s}}`;
    return s;
  }

  citationNode(nums: number[]): string {
    if (nums.length === 0) return '\\cite{?}';
    return `\\cite{${nums.map(n => `ref-${n}`).join(',')}}`;
  }

  hardBreak(): string {
    return '\\\\\n';
  }

  bulletList(items: unknown[][]): string {
    const entries = (items as string[][]).map(inlines => `  \\item ${inlines.join('')}`).join('\n');
    return `\\begin{itemize}\n${entries}\n\\end{itemize}`;
  }

  orderedList(items: unknown[][]): string {
    const entries = (items as string[][]).map(inlines => `  \\item ${inlines.join('')}`).join('\n');
    return `\\begin{enumerate}\n${entries}\n\\end{enumerate}`;
  }

  resizableImage(src: string, alt: string, widthAttr: string, meta?: ImageMeta): string {
    this.figureIndex++;
    const figName = `figure-${this.figureIndex}`;

    if (!meta?.buffer || meta.buffer.byteLength === 0) {
      return `% [image ${figName} unavailable — not included in zip]`;
    }

    const ext = (meta.mimeType.includes('jpeg') || meta.mimeType.includes('jpg')) ? 'jpg' : 'png';
    const fullFigName = `${figName}.${ext}`;
    this.zip.folder('figures')!.file(fullFigName, meta.buffer);

    // Parse width: "400px" → fraction of \textwidth, "100%" → \textwidth, unknown → 0.8\textwidth
    let widthSpec = '0.8\\textwidth';
    if (widthAttr.endsWith('%')) {
      const pct = Math.min(parseFloat(widthAttr) / 100, 1.0);
      widthSpec = `${pct.toFixed(2)}\\textwidth`;
    } else if (widthAttr.endsWith('px')) {
      const px = parseInt(widthAttr);
      // Approximate: 600px ≈ \textwidth on a standard 6-inch text block
      const frac = Math.min(Math.max(px / 600, 0), 1.0);
      widthSpec = `${frac.toFixed(2)}\\textwidth`;
    }

    return [
      `\\begin{figure}[htbp]`,
      `  \\centering`,
      `  \\includegraphics[width=${widthSpec}]{figures/${fullFigName}}`,
      alt ? `  \\caption{${esc(alt)}}` : '',
      `\\end{figure}`,
    ].filter(Boolean).join('\n');
  }

  table(rows: unknown[][][]): string {
    if (rows.length === 0) return '';
    const colCount = (rows[0] as unknown[][]).length;
    const colSpec = Array(colCount).fill('l').join(' | ');
    const rowStrings = (rows as string[][][]).map(cells =>
      cells.map(inlines => inlines.join('')).join(' & ')
    );
    return [
      `\\begin{table}[htbp]`,
      `  \\centering`,
      `  \\begin{tabular}{${colSpec}}`,
      `    \\hline`,
      rowStrings.map(r => `    ${r} \\\\`).join('\n    \\hline\n'),
      `    \\hline`,
      `  \\end{tabular}`,
      `\\end{table}`,
    ].join('\n');
  }
}
