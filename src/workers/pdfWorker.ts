import * as pdfjsLib from 'pdfjs-dist';

// Disable pdfjsLib's own sub-worker. When pdfjs runs inside a Worker,
// its internal WorkerMessageHandler conflicts with any message-passing
// framework. Setting workerSrc to '' tells pdfjs to run synchronously
// in the current context instead of spawning another worker.
pdfjsLib.GlobalWorkerOptions.workerSrc = '';

function cleanPdfText(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/(\w)-\n(\w)/g, '$1$2')
    .replace(/^[ \t]*(\d{1,4}|[Pp]age\s+\d+(\s+of\s+\d+)?)[ \t]*$/gm, '')
    .replace(/^.*[Dd]ownloaded\s+from\s+.*$/gm, '')
    .replace(/^.*©\s*\d{4}.*$/gm, '')
    .replace(/^.*[Aa]ll\s+rights\s+reserved.*$/gm, '')
    .trim();
}

type ExtractRequest = { type: 'extract'; payload: ArrayBuffer };
type ResultMessage = { type: 'result'; text: string };
type ErrorMessage = { type: 'error'; message: string };

self.onmessage = async (e: MessageEvent<ExtractRequest>) => {
  if (e.data.type !== 'extract') return;
  try {
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(e.data.payload) }).promise;
    let raw = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      raw += content.items.map((item: any) => item.str).join(' ') + '\n\n';
    }
    const msg: ResultMessage = { type: 'result', text: cleanPdfText(raw) };
    (self as any).postMessage(msg);
  } catch (err: any) {
    const msg: ErrorMessage = { type: 'error', message: err?.message ?? String(err) };
    (self as any).postMessage(msg);
  }
};
