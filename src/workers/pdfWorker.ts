import * as pdfjsLib from 'pdfjs-dist';

// Set workerSrc from the main thread context — Vite statically resolves this
// new URL() call and copies pdf.worker.mjs to the assets folder, so the path
// is correct for both dev and the /manuscriptAI/ base on GitHub Pages.
// This must NOT be inside a Web Worker; call this module from the main thread.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).href;

function cleanPdfText(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/(\w)-\n(\w)/g, '$1$2')
    .replace(/^[ \t]*(\d{1,4}|[Pp]age\s+\d+(\s+of\s+\d+)?)[ \t]*$/gm, '')
    .replace(/^.*[Dd]ownloaded\s+from\s+.*$/gm, '')
    .replace(/^.*©\s*\d{4}.*$/gm, '')
    .replace(/^.*[Aa]ll\s+rights\s+reserved.*$/gm, '')
    .replace(/^[ \t]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractTextFromPDF(file: File): Promise<string> {
  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(data) }).promise;
  let raw = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    raw += content.items.map((item: any) => item.str).join(' ') + '\n\n';
  }
  return cleanPdfText(raw);
}
