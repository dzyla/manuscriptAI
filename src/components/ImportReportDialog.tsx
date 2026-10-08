import { useEffect, useMemo, useRef, useState } from 'react';
import type { ImportResult, HeadingCandidate } from '../docx/read';
import { preservedReadOnly, summarizeReport, type ImportReport } from '../docx/fidelity';

/** The part of an `ImportResult` the dialog reads. */
export type ReportedImport = Pick<ImportResult, 'report' | 'headingCandidates'> & { fileName?: string };

export interface ReportRow {
  key: string;
  label: string;
  value: number;
  /** Said under the figure when the figure alone could be misread. */
  note?: string;
}

/**
 * The noun alone: `nounFor(1, 'heading')` is `"heading"`, `nounFor(2, 'heading')` is `"headings"`. NOT `plural` from docx/fidelity.ts,
 * which returns the count as well (`"2 headings"`); the two were once both called `plural`, so moving a message between files
 * silently changed its output.
 */
const nounFor = (n: number, one: string, many = one + 's') => (n === 1 ? one : many);

/**
 * The report as separate figures. Tracked changes, formatting changes, comments, read-only pieces and warnings are DIFFERENT things
 * and each keeps its own row: one combined "N things need attention" number hides which of them the author has to deal with.
 * Rows with nothing in them are left out.
 */
export function reportRows(result: Pick<ImportResult, 'report'>): ReportRow[] {
  const r: ImportReport = result.report;
  const c = r.counts;
  const rows: ReportRow[] = [];
  const add = (key: string, label: string, value: number | undefined, note?: string): void => {
    // `!== 0`, not `> 0`: a NEGATIVE figure (read-only pieces fewer than the pieces already described, which means a double count
    // somewhere) must show as a row, not vanish the way a clamped 0 would.
    if (value !== undefined && value !== 0) rows.push({ key, label, value, ...(note ? { note } : {}) });
  };
  add('trackedChange', 'Tracked changes', c.trackedChange);
  add('formatChange', 'Formatting changes (tracked)', c.formatChange);
  const notInText = r.commentsNotInText ?? 0;
  add(
    'comment',
    'Comments',
    c.comment,
    notInText > 0 ? (notInText >= (c.comment ?? 0) ? 'None is anchored in the main text.' : `${notInText} of them ${notInText === 1 ? 'is' : 'are'} not anchored in the main text.`) : undefined,
  );
  const { count: preserved, hasDescribed } = preservedReadOnly(r);
  add('preserved', hasDescribed ? 'Other pieces preserved read-only' : 'Pieces preserved read-only', preserved);
  add('warning', 'Warnings', r.warnings.length);
  return rows;
}

/** What was read and is editable or shown, for orientation. */
export function readRows(result: Pick<ImportResult, 'report'>): ReportRow[] {
  const r = result.report;
  const c = r.counts;
  const rows: ReportRow[] = [];
  const add = (key: string, label: string, value: number | undefined): void => {
    if (value && value > 0) rows.push({ key, label, value });
  };
  add('page', 'Pages (as Word last counted them)', r.pageCount);
  add('list', 'Lists', c.list);
  add('table', 'Tables', c.table);
  add('image', 'Images', (c.inlineImage ?? 0) + (c.floatingImageSquare ?? 0) + (c.floatingImageOther ?? 0));
  add('citation', 'Citations', (c.nativeCitation ?? 0) + (c.externalCitation ?? 0));
  add('bibliography', 'Bibliographies', c.externalBibliography);
  // Shown even at 0 when there are pictures: "0 of 3 paired" tells the author the pairing was tried and found nothing. `images` counts
  // TOP-LEVEL pictures only (pictures inside table cells are not paired at import), so it can be smaller than the "Images" row above.
  // The key is `figureCaption`, not `caption`: `counts.caption` is Word's Caption STYLE, which may get its own row.
  if (r.figures) rows.push({ key: 'figureCaption', label: `Pictures paired with a caption (of ${r.figures.images})`, value: r.figures.captioned });
  return rows;
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), [href], select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Keep Tab (and Shift+Tab) inside a modal: from the last control it goes to the first, and back. */
function trapTab(e: React.KeyboardEvent<HTMLElement>): void {
  if (e.key !== 'Tab') return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE));
  if (!items.length) {
    e.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !e.currentTarget.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !e.currentTarget.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

const LEVEL_LABEL: Record<HeadingCandidate['level'], string> = { 1: 'H1', 2: 'H2', 3: 'H3' };

export interface ImportReportDialogProps {
  result: ReportedImport;
  /** Called with the headings the author accepted, and only those: nothing else is applied. */
  onConfirm: (decisions: { acceptedHeadings: HeadingCandidate[] }) => void;
  onCancel: () => void;
  /** True while the import is being written: the buttons are disabled so it cannot be started twice. */
  busy?: boolean;
  /**
   * `view`: the report of an import that already happened, shown again (from the File menu). Read-only: the headings show which were
   * accepted, there is nothing to confirm, and the one button closes it (through `onCancel`).
   */
  mode?: 'review' | 'view';
  /** In `view` mode: the `index` of each heading that was accepted. */
  acceptedIndexes?: number[];
}

export default function ImportReportDialog({ result, onConfirm, onCancel, busy = false, mode = 'review', acceptedIndexes = [] }: ImportReportDialogProps) {
  const viewing = mode === 'view';
  const { report, headingCandidates } = result;
  // Nothing is accepted until the author says so: the report promises that no inferred heading is applied on its own.
  const [accepted, setAccepted] = useState<ReadonlySet<number>>(() => new Set(viewing ? acceptedIndexes : []));
  const rows = useMemo(() => reportRows(result), [result]);
  const read = useMemo(() => readRows(result), [result]);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // The parent re-renders often and passes fresh callbacks: read the latest from a ref, so the listener is added once and focus is
  // moved to Cancel only when the dialog opens (not again on every render, which would pull it away from a checkbox being used).
  const latest = useRef({ onCancel, busy });
  latest.current = { onCancel, busy };
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !latest.current.busy) latest.current.onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggle = (index: number): void => {
    const next = new Set(accepted);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setAccepted(next);
  };
  const acceptedList = headingCandidates.filter(h => accepted.has(h.index));
  const confirm = (): void => {
    if (!busy) onConfirm({ acceptedHeadings: acceptedList });
  };

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center p-4" data-testid="import-report-dialog">
      <div className="absolute inset-0 bg-stone-900/40 backdrop-blur-sm" onClick={busy ? undefined : onCancel} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-report-title"
        onKeyDown={trapTab}
        className="relative w-full max-w-2xl rounded-2xl shadow-2xl flex flex-col"
        style={{ border: '1px solid var(--border)', maxHeight: '88vh', background: 'var(--surface-1)', color: 'var(--text-primary)' }}
      >
        <div className="p-5" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <h2 id="import-report-title" className="text-base font-bold">{viewing ? 'Import report' : 'Import Word document'}</h2>
          {result.fileName && <p className="text-xs mt-0.5 break-all" style={{ color: 'var(--text-muted)' }}>{result.fileName}</p>}
          <p className="text-xs mt-2 font-medium" data-testid="import-summary">{summarizeReport(report)}</p>
        </div>

        <div className="p-5 overflow-y-auto space-y-5 text-xs">
          {viewing ? (
            <p style={{ color: 'var(--text-secondary)' }} data-testid="view-notice">
              This is what the import found when this document was opened from Word. Everything listed as kept is still in the file and
              comes back on export, but is not shown or editable here.
            </p>
          ) : (
          <p style={{ color: 'var(--text-secondary)' }} data-testid="replace-notice">
            Importing replaces the document that is open now, and Undo will not bring it back. The open document is saved first and, if it
            has any content, kept: use &quot;Restore previous document&quot; (in the File menu, or the button on the message after the
            import) to bring it back, or find a snapshot of its text in Version History. Choose Cancel to keep it exactly as it is.
          </p>
          )}

          {(rows.length > 0 || read.length > 0) && (
            <section aria-label="Report">
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5">
                {rows.map(row => (
                  <div key={row.key} className="contents" data-testid={`row-${row.key}`}>
                    <dt>
                      {row.label}
                      {row.note && <span className="block" style={{ color: 'var(--text-muted)' }}>{row.note}</span>}
                    </dt>
                    <dd className="font-semibold tabular-nums text-right">{row.value}</dd>
                  </div>
                ))}
              </dl>
              {read.length > 0 && (
                <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 mt-3 pt-3" style={{ borderTop: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
                  {read.map(row => (
                    <div key={row.key} className="contents" data-testid={`row-${row.key}`}>
                      <dt>{row.label}</dt>
                      <dd className="tabular-nums text-right">{row.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </section>
          )}

          {report.warnings.length > 0 && (
            <section aria-label="Warnings">
              <h3 className="font-semibold mb-1.5">Warnings ({report.warnings.length})</h3>
              <ul className="space-y-1.5 list-disc pl-4" data-testid="warnings">
                {report.warnings.map((w, i) => (
                  <li key={`${i}-${w.feature}`}>{w.message}</li>
                ))}
              </ul>
            </section>
          )}

          {headingCandidates.length > 0 && (
            <section aria-label="Inferred headings">
              <div className="flex items-center justify-between gap-3 mb-1.5">
                <h3 className="font-semibold">
                  Inferred headings ({acceptedList.length} of {headingCandidates.length} accepted)
                </h3>
                {!viewing && <div className="flex gap-2 shrink-0">
                  <button type="button" disabled={busy} onClick={() => setAccepted(new Set(headingCandidates.map(h => h.index)))} className="px-2 py-1 rounded-md border" style={{ borderColor: 'var(--border)' }}>
                    Accept all
                  </button>
                  <button type="button" disabled={busy} onClick={() => setAccepted(new Set())} className="px-2 py-1 rounded-md border" style={{ borderColor: 'var(--border)' }}>
                    Reject all
                  </button>
                </div>}
              </div>
              <ul className="space-y-2" data-testid="heading-candidates">
                {headingCandidates.map(h => (
                  <li key={h.index} className="rounded-lg p-2.5" style={{ border: '1px solid var(--border-subtle)', background: 'var(--surface-2)' }}>
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={accepted.has(h.index)}
                        disabled={busy || viewing}
                        onChange={() => toggle(h.index)}
                        aria-label={`Accept heading: ${h.text}`}
                      />
                      <span className="min-w-0">
                        <span className="font-semibold mr-1.5" style={{ color: 'var(--text-muted)' }}>{LEVEL_LABEL[h.level]}</span>
                        <span className="font-medium break-words">{h.text}</span>
                      </span>
                    </label>
                    {/* The evidence is shown as the reader wrote it, one line per check: it states which checks actually fired. */}
                    <ul className="mt-1.5 pl-6 list-disc space-y-0.5" style={{ color: 'var(--text-secondary)' }} data-testid="evidence">
                      {h.evidence.map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <div className="p-4 flex justify-end gap-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel} className="px-3 py-1.5 text-xs rounded-lg border" style={{ borderColor: 'var(--border)' }}>
            {viewing ? 'Close' : 'Cancel'}
          </button>
          {!viewing && (
            <button type="button" disabled={busy} onClick={confirm} className="px-3 py-1.5 text-xs rounded-lg font-semibold bg-stone-900 text-white disabled:opacity-60">
              {busy ? 'Importing…' : `Import${acceptedList.length ? ` with ${acceptedList.length} ${nounFor(acceptedList.length, 'heading')}` : ''}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const STAGE_LABEL: Record<string, string> = {
  opening: 'Opening the file',
  styles: 'Reading fonts and styles',
  body: 'Reading text, tables and images',
  headings: 'Looking for section headings',
  report: 'Preparing the report',
};

export interface ImportProgressDialogProps {
  fileName: string;
  /** Bytes; shown for a large file so a long read is visibly about that file. */
  size?: number;
  stage?: string | null;
  /** Ends the read. Nothing has been written yet, so nothing needs undoing. */
  onCancel: () => void;
}

/** Shown while the worker reads the file. Always offers a way out: a wrong file must not have to be waited out. */
export function ImportProgressDialog({ fileName, size, stage, onCancel }: ImportProgressDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const latestCancel = useRef(onCancel);
  latestCancel.current = onCancel;
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') latestCancel.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const mb = size !== undefined ? size / (1024 * 1024) : 0;
  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center p-4" data-testid="import-progress-dialog">
      <div className="absolute inset-0 bg-stone-900/40 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-progress-title"
        onKeyDown={trapTab}
        className="relative w-full max-w-sm rounded-2xl shadow-2xl p-5"
        style={{ border: '1px solid var(--border)', background: 'var(--surface-1)', color: 'var(--text-primary)' }}
      >
        <h2 id="import-progress-title" className="text-sm font-bold">Reading Word document</h2>
        <p className="text-xs mt-1 break-all" style={{ color: 'var(--text-secondary)' }} data-testid="progress-file">
          {fileName}
          {mb >= 1 ? ` (${mb.toFixed(1)} MB)` : ''}
        </p>
        <p className="text-xs mt-3" role="status" aria-live="polite" data-testid="progress-stage" style={{ color: 'var(--text-muted)' }}>
          {(stage && STAGE_LABEL[stage]) || 'Starting'}…
        </p>
        <div className="flex justify-end mt-4">
          <button ref={cancelRef} type="button" onClick={onCancel} className="px-3 py-1.5 text-xs rounded-lg border" style={{ borderColor: 'var(--border)' }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
