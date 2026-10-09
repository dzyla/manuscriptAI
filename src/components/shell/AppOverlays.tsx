import type { ExportFormat } from '../../hooks/useExport';

export interface ToastState { message: string; type: 'success' | 'info' | 'error'; action?: { label: string; onClick: () => void } }

/** The transient message at the bottom. A message with a button (restore the replaced document) stays long enough to use it; the caller owns the timer. */
export function Toast({ toast, onDismiss }: { toast: ToastState; onDismiss: () => void }) {
  return (
    <div className="fixed bottom-10 left-1/2 -translate-x-1/2 z-[200]">
      <div
        className={`toast-enter px-4 py-2.5 rounded-xl text-xs font-medium shadow-lg border flex items-center gap-2 max-w-md ${
          toast.type === 'success' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : toast.type === 'error' ? 'bg-rose-50 text-rose-700 border-rose-200' : 'border-stone-200'
        }`}
        style={toast.type === 'info' ? { background: 'var(--surface-1)', color: 'var(--text-secondary)' } : {}}
      >
        {toast.type === 'success' ? '✓' : toast.type === 'error' ? '✕' : 'ℹ'} {toast.message}
        {toast.action && (
          <button
            type="button"
            data-testid="control-toast-action"
            className="ml-2 px-2 py-0.5 rounded-md border font-semibold shrink-0"
            style={{ borderColor: 'currentColor' }}
            onClick={() => { const run = toast.action!.onClick; onDismiss(); run(); }}
          >
            {toast.action.label}
          </button>
        )}
      </div>
    </div>
  );
}

/** Never auto-dismissed: the document did not load, or what is saved could not be opened. */
export function StorageBanner({ failed, quarantined }: { failed: boolean; quarantined: boolean }) {
  return (
    <div role="alert" className="fixed top-3 left-1/2 -translate-x-1/2 z-[210] px-4 py-2.5 rounded-xl text-xs font-medium shadow-lg border bg-rose-50 text-rose-700 border-rose-200 max-w-lg">
      ✕ {failed
        ? 'Your document could not be loaded. Changes will not be saved until you reload.'
        : `Your saved document could not be opened (it may come from a newer version of the app). ${quarantined ? 'A protected copy was kept.' : 'A protected copy could NOT be made; the original is left untouched.'} You are seeing a blank document; changes will not be saved until you start a New Manuscript, apply a template or load a workspace file.`}
    </div>
  );
}

/** The acknowledgement before Markdown, Word or LaTeX leaves the app. */
export function ExportWarning({ format, onCancel, onConfirm }: { format: ExportFormat; onCancel: () => void; onConfirm: (f: ExportFormat) => void }) {
  return (
    <div className="fixed inset-0 z-[160] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-stone-900/40 backdrop-blur-sm" />
      <div className="relative rounded-2xl shadow-2xl p-6 max-w-sm w-full border" style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}>
        <h3 className="text-sm font-bold mb-3" style={{ color: 'var(--text-primary)' }}>Before You Export</h3>
        <p className="text-xs leading-relaxed mb-4" style={{ color: 'var(--text-secondary)' }}>
          AI tools assist in drafting and editing, but they can produce errors, hallucinations, or scientifically incorrect statements. By downloading this manuscript you confirm that:
        </p>
        <ul className="text-xs space-y-1.5 mb-5 list-none">
          {[
            'You have reviewed all AI-generated content for accuracy.',
            'You take sole responsibility for the scientific correctness and integrity of this work.',
            'AI suggestions are a starting point — not a substitute for expert judgment.',
          ].map(item => (
            <li key={item} className="flex items-start gap-2" style={{ color: 'var(--text-primary)' }}>
              <span className="text-emerald-600 font-bold shrink-0">✓</span>{item}
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <button data-testid="control-export-cancel" onClick={onCancel} className="flex-1 py-2 border rounded-xl text-xs font-semibold transition-colors hover:bg-stone-50" style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>
            Cancel
          </button>
          <button data-testid="control-export-confirm" onClick={() => onConfirm(format)} className="flex-1 py-2 bg-stone-900 text-white rounded-xl text-xs font-semibold hover:bg-stone-800 transition-colors">
            I Acknowledge — Download
          </button>
        </div>
      </div>
    </div>
  );
}

const SHORTCUTS = [
  ['Ctrl+S', 'Save workspace'], ['Ctrl+Shift+A', 'Analyze with all agents'], ['Ctrl+?', 'Toggle shortcuts'],
  ['Ctrl+B', 'Bold'], ['Ctrl+I', 'Italic'], ['Ctrl+U', 'Underline'],
];

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-stone-900/30 backdrop-blur-sm" />
      <div className="relative rounded-2xl shadow-2xl p-6 max-w-sm w-full border" style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}>
        <h3 className="text-sm font-bold mb-4" style={{ color: 'var(--text-primary)' }}>Keyboard Shortcuts</h3>
        <div className="space-y-2 text-xs">
          {SHORTCUTS.map(([key, desc]) => (
            <div key={key} className="flex justify-between items-center py-1.5" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <span style={{ color: 'var(--text-secondary)' }}>{desc}</span>
              <kbd className="px-2 py-0.5 rounded-md text-[10px] font-mono font-bold border" style={{ background: 'var(--surface-2)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}>{key}</kbd>
            </div>
          ))}
        </div>
        <button data-testid="control-shortcuts-close" onClick={onClose} className="mt-4 w-full py-2 bg-stone-800 text-white rounded-xl text-xs font-semibold hover:bg-stone-700 transition-colors">Close</button>
      </div>
    </div>
  );
}
