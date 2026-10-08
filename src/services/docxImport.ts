/**
 * Starting, tracking and cancelling a .docx import. The reading happens in a Worker (docxImportWorker.ts), so a large document
 * does not stop the interface from painting; nothing is written until the author confirms (`useDocumentStore.importDocx`).
 *
 * Cancelling terminates the worker. A cancelled read has written nothing (the reader never writes), so there is no partial state to
 * undo: the read result is simply never used and the worker's memory is released with it.
 */
import { proxy, wrap, type Remote } from 'comlink';
import type { ImportResult, ImportStage } from '../docx/read';
import type { DocxImportWorkerApi } from '../workers/docxImportWorker';
import type { WorkerImportResult } from '../workers/docxImportCore';

export type { ImportStage };

/** The part of a worker connection the import needs; a test double implements it directly. */
export interface ImportWorkerHandle {
  read(data: ArrayBuffer, fileName: string, onStage: (stage: ImportStage) => void): Promise<WorkerImportResult>;
  terminate(): void;
}

export type ImportWorkerFactory = () => ImportWorkerHandle;

/** The production factory: a module Worker wrapped with Comlink. One worker per import, ended when the import ends. */
export const createImportWorker: ImportWorkerFactory = () => {
  const raw = new Worker(new URL('../workers/docxImportWorker.ts', import.meta.url), { type: 'module' });
  const remote: Remote<DocxImportWorkerApi> = wrap<DocxImportWorkerApi>(raw);
  return {
    read: (data, fileName, onStage) => remote.read(data, fileName, proxy(onStage)),
    terminate: () => raw.terminate(),
  };
};

export class ImportCancelled extends Error {
  constructor() {
    super('Import cancelled.');
    this.name = 'ImportCancelled';
  }
}

export interface RunningImport {
  /** Resolves with the result (with the file's own bytes attached as `original`); rejects with `ImportCancelled` after `cancel()`. */
  promise: Promise<ImportResult>;
  cancel(): void;
}

export interface ImportableFile {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * The bytes are COPIED to the worker (not transferred), so this thread keeps its own for `original`: the package the repository
 * stores so unmodelled parts can be re-emitted on export.
 */
export function startDocxImport(file: ImportableFile, createWorker: ImportWorkerFactory, onStage: (stage: ImportStage) => void = () => {}): RunningImport {
  let worker: ImportWorkerHandle | null = null;
  let cancelled = false;
  let rejectCancel: (e: Error) => void = () => {};
  const cancelled$ = new Promise<never>((_, reject) => { rejectCancel = reject; });
  const end = (): void => {
    worker?.terminate();
    worker = null;
  };
  const work = (async (): Promise<ImportResult> => {
    const data = await file.arrayBuffer();
    if (cancelled) throw new ImportCancelled();
    if (data.byteLength === 0) throw new Error('This file is empty.');
    worker = createWorker();
    try {
      const result = await worker.read(data, file.name, stage => { if (!cancelled) onStage(stage); });
      if (cancelled) throw new ImportCancelled();
      return { ...result, original: data };
    } finally {
      end();
    }
  })();
  work.catch(() => {}); // when cancel() wins the race below, a later failure of the abandoned read is not an unhandled rejection
  cancelled$.catch(() => {});
  return {
    promise: Promise.race([work, cancelled$]),
    cancel() {
      if (cancelled) return;
      cancelled = true;
      end();
      rejectCancel(new ImportCancelled());
    },
  };
}

/** The title a document gets when imported: the file name without its extension. */
export function titleFromFileName(name: string): string {
  const base = name.replace(/\.[^./\\]+$/, '').trim();
  return base || 'Untitled Manuscript';
}
