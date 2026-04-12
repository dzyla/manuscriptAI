import * as pdfjsLib from 'pdfjs-dist';
import { WorkerMessageHandler } from 'pdfjs-dist/build/pdf.worker.min.mjs';
import { expose } from 'comlink';

// This file runs in a Worker context — no DOM, no React.
// Inject the WorkerMessageHandler into globalThis so pdfjs uses it directly
// instead of trying to spawn a nested worker (which hangs in this context).
// pdfjs v5 checks globalThis.pdfjsWorker?.WorkerMessageHandler as its fake-worker path.
(globalThis as any).pdfjsWorker = { WorkerMessageHandler };

function cleanPdfText(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/(\w)-\n(\w)/g, '$1$2')
    .replace(/^[ \t]*(\d{1,4}|[Pp]age\s+\d+(\s+of\s+\d+)?)[ \t]*$/gm, '')
    .replace(/^.*[Dd]ownloaded\s+from\s+.*$/gm, '')
    .replace(/^.*©\s*\d{4}.*$/gm, '')
    .replace(/^.*[Aa]ll\s+rights\s+reserved.*$/gm, '')
    .replace(/^[ \t]*[Dd][Oo][Ii]:\s*10\.\S+[ \t]*$/gm, '')
    .replace(/^.{0,3}$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const pdfWorkerApi = {
  async extractText(arrayBuffer: ArrayBuffer): Promise<string> {
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map((item: any) => item.str).join(' ');
      text += pageText + '\n\n';
    }
    return cleanPdfText(text);
  },
};

expose(pdfWorkerApi);

export type PdfWorkerApi = typeof pdfWorkerApi;
