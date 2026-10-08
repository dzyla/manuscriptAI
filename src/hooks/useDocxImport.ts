import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSONContent } from '@tiptap/core';
import type { ImportResult, HeadingCandidate } from '../docx/read';
import { createImportWorker, ImportCancelled, startDocxImport, titleFromFileName, type ImportableFile, type ImportWorkerFactory, type RunningImport } from '../services/docxImport';

export type DocxImportState =
  | { phase: 'reading'; fileName: string; size: number; stage: string | null }
  | { phase: 'review'; result: ImportResult; committing: boolean }
  | null;

export interface DocxImportDeps {
  /** Commit the confirmed import (`useDocumentStore.importDocx`); resolves with the committed document. */
  commit(result: ImportResult, decisions: { title: string; acceptedHeadings: HeadingCandidate[] }): Promise<JSONContent>;
  /** Put the committed document in the editor (`EditorRef.setDocument`, which records no undo history). */
  showInEditor(doc: JSONContent): void;
  /** Called once the import is committed and shown. */
  onImported?(result: ImportResult): void;
  notify(message: string, type: 'success' | 'info' | 'error', action?: { label: string; onClick: () => void }): void;
  /** A button for the success message (e.g. "Restore previous document"), or undefined when there is nothing to offer. */
  afterImportAction?(): { label: string; onClick: () => void } | undefined;
  createWorker?: ImportWorkerFactory;
}

/**
 * The life of one .docx import in the interface: read in a worker (cancellable), review the report, confirm (one transaction) or
 * cancel. One import at a time. Nothing is written before `confirm`, so cancelling at any point leaves the open document and the
 * database exactly as they were; a commit that fails does the same and keeps the report open so the author can retry or cancel.
 */
export function useDocxImport(deps: DocxImportDeps) {
  const [state, setState] = useState<DocxImportState>(null);
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const running = useRef<RunningImport | null>(null);
  // Decided synchronously: state updates lag a second click made on the same tick.
  const busy = useRef(false);
  const stateRef = useRef<DocxImportState>(null);
  stateRef.current = state;

  useEffect(() => () => { running.current?.cancel(); }, []);

  const start = useCallback(async (file: ImportableFile): Promise<void> => {
    if (busy.current) {
      depsRef.current.notify('An import is already in progress.', 'info');
      return;
    }
    busy.current = true;
    const run = startDocxImport(file, depsRef.current.createWorker ?? createImportWorker, stage =>
      setState(s => (s?.phase === 'reading' ? { ...s, stage } : s)),
    );
    running.current = run;
    setState({ phase: 'reading', fileName: file.name, size: file.size, stage: null });
    try {
      const result = await run.promise;
      setState({ phase: 'review', result, committing: false });
    } catch (err) {
      // Cancelled by the author: cancelRead already cleared the state (and a NEW import may have started since), so touch nothing.
      if (err instanceof ImportCancelled) return;
      busy.current = false;
      setState(null);
      console.error('Reading the Word document failed', err);
      depsRef.current.notify(`Could not import ${file.name}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      if (running.current === run) running.current = null;
    }
  }, []);

  /** Stop reading. Nothing has been written, so there is nothing to undo. */
  const cancelRead = useCallback((): void => {
    running.current?.cancel();
    running.current = null;
    busy.current = false;
    setState(null);
  }, []);

  /** Close the report without importing: the result is dropped; the open document was never touched. */
  const cancelReview = useCallback((): void => {
    if (stateRef.current?.phase === 'review' && stateRef.current.committing) return; // a commit in flight cannot be called back
    busy.current = false;
    setState(null);
  }, []);

  const confirm = useCallback(async (acceptedHeadings: HeadingCandidate[]): Promise<void> => {
    const current = stateRef.current;
    if (current?.phase !== 'review' || current.committing) return;
    const { result } = current;
    stateRef.current = { ...current, committing: true }; // synchronous guard against a double click
    setState({ ...current, committing: true });
    try {
      const doc = await depsRef.current.commit(result, { title: titleFromFileName(result.fileName ?? ''), acceptedHeadings });
      depsRef.current.showInEditor(doc);
      busy.current = false;
      setState(null);
      depsRef.current.onImported?.(result);
      depsRef.current.notify(`Imported ${result.fileName ?? 'document'}`, 'success', depsRef.current.afterImportAction?.());
    } catch (err) {
      // The transaction rolled back: the previous document is intact. Keep the report open so the author can retry or cancel.
      console.error('Importing the Word document failed', err);
      depsRef.current.notify(`Import failed, your document is unchanged: ${err instanceof Error ? err.message : String(err)}`, 'error');
      setState({ phase: 'review', result, committing: false });
    }
  }, []);

  return { state, start, cancelRead, cancelReview, confirm };
}
