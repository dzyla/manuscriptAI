import * as mammoth from 'mammoth';
import { expose } from 'comlink';

// This file runs in a Worker context — no DOM, no React.

const docxWorkerApi = {
  async extractText(arrayBuffer: ArrayBuffer): Promise<string> {
    const result = await mammoth.extractRawText({ arrayBuffer });
    return result.value;
  },
};

expose(docxWorkerApi);

export type DocxWorkerApi = typeof docxWorkerApi;
