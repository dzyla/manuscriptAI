// PDF parsing has been moved to the main thread in Sidebar.tsx.
// pdfjs-dist creates its own internal worker from the main thread context,
// which resolves import.meta.url correctly and avoids the static-initializer
// side-effect that WorkerMessageHandler triggers when imported inside a
// Comlink worker (it calls initializeFromPort(self), conflicting with Comlink).
//
// This file is kept as a placeholder so existing build references don't break.

export type PdfWorkerApi = {
  extractText(arrayBuffer: ArrayBuffer): Promise<string>;
};
