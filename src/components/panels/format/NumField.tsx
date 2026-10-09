import { useEffect, useState } from 'react';

/**
 * A number the author types. It commits only a value its parser accepts; anything else stays in the box with a reason, and the document is not touched.
 * `value` is the committed number (or null when unset). Leaving the box with a rejected draft puts the committed value back.
 */
export function NumField({ id, label, value, parse, onCommit, rule, step, unit, wide }: {
  id: string; label: string; value: number | null;
  /** Typed text to a number, to null for "unset" (when `allowUnset`), or undefined when rejected. */
  parse: (text: string) => number | null | undefined;
  onCommit: (v: number | null) => void;
  /** Shown beside the box when the draft is rejected. */
  rule: string; step?: number; unit?: string; wide?: boolean;
}) {
  const show = (v: number | null) => (v === null ? '' : String(v));
  const [draft, setDraft] = useState(show(value));
  const [bad, setBad] = useState(false);
  // a change that came from elsewhere (a preset, another field) replaces the draft; a rejected draft is left alone while the value is unchanged
  useEffect(() => { if (parse(draft) !== value) { setDraft(show(value)); setBad(false); } }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const change = (text: string, badInput = false) => {
    setDraft(text);
    const v = badInput ? undefined : parse(text); // a half-typed "1e" reads as blank to a number input; that is not "unset"
    if (v === undefined) { setBad(true); return; }
    setBad(false);
    if (v !== value) onCommit(v);
  };
  return (
    <div className={wide ? 'col-span-2' : ''}>
      <label htmlFor={id} className="block text-[10px] font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>{label}{unit ? ` (${unit})` : ''}</label>
      <input
        id={id} data-testid={`control-${id}`} type="number" step={step} value={draft} aria-invalid={bad || undefined}
        onChange={e => change(e.target.value, e.target.validity?.badInput)}
        onBlur={() => { if (bad) { setDraft(show(value)); setBad(false); } }}
        className="w-full text-xs rounded-lg border px-2 py-1"
        style={{ background: 'var(--surface-1)', borderColor: bad ? '#e11d48' : 'var(--border)', color: 'var(--text-primary)' }}
      />
      {bad && <p data-testid={`error-${id}`} role="alert" className="text-[10px] mt-0.5 text-rose-600">{rule}</p>}
    </div>
  );
}
