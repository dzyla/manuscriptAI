import { expose } from 'comlink';
import { readForImport } from './docxImportCore';

// This file runs in a Worker context — no DOM, no React. It only reads: nothing is written to IndexedDB from here.
const docxImportWorkerApi = {
  read: readForImport,
};

expose(docxImportWorkerApi);

export type DocxImportWorkerApi = typeof docxImportWorkerApi;
