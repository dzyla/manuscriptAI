/**
 * What the import worker does, as a plain function so it can be tested without a Worker (docxImportWorker.ts only exposes it).
 * No DOM, no React: this runs in a Web Worker.
 */
import { readDocx, type ImportResult, type ImportStage } from '../docx/read';
import { DocxOpenError, type DocxOpenErrorCode } from '../docx/read/package';

/**
 * What crosses the worker boundary. `original` (the input bytes) is left out: the caller already holds them, so sending them back
 * would copy up to 50 MB for nothing, and a buffer the worker was handed is not the caller's to return. The caller re-attaches its
 * own copy (see `startDocxImport`). Everything that remains is plain data and survives `structuredClone`.
 */
export type WorkerImportResult = Omit<ImportResult, 'original'>;

const MESSAGES: Record<DocxOpenErrorCode, string> = {
  'not-docx': 'This file is not a Word (.docx) document.',
  macro: 'Macro-enabled Word documents (.docm, .dotm) are not opened. Save a copy as .docx without macros and import that.',
  'too-large': 'This document is larger than the import limits allow.',
  'too-many-entries': 'This document has more parts than the import limits allow.',
  bomb: 'This document expands far beyond its stored size, so it was not opened.',
  'bad-path': 'This document contains an unsafe file path, so it was not opened.',
  corrupt: 'This Word document is damaged or incomplete and could not be read.',
};

/** Comlink carries only an error's name and message across the boundary (its `code` is lost), so the reader's refusal is worded here for the author. */
export class DocxImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocxImportError';
  }
}

export function friendlyOpenError(err: unknown): Error {
  if (err instanceof DocxOpenError) return new DocxImportError(`${MESSAGES[err.code] ?? 'This document could not be read.'} (${err.message})`);
  return err instanceof Error ? err : new Error(String(err));
}

export async function readForImport(data: ArrayBuffer, fileName: string, onStage?: (stage: ImportStage) => void): Promise<WorkerImportResult> {
  let result: ImportResult;
  try {
    result = await readDocx(data, undefined, fileName, onStage);
  } catch (err) {
    throw friendlyOpenError(err);
  }
  const { original: _original, ...rest } = result;
  return rest;
}
