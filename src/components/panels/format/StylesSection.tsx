import { useEffect, useState } from 'react';
import type { DocFormat } from '../../../types';
import { resolveStyle } from '../../../services/formatPresets';
import { FONT_RANGE, baseFormat, builtinStyleIds, parseBounded, styleName, withStyleField } from './formatEdit';
import { NumField } from './NumField';

function FamilyField({ id, value, inherited, required, onCommit }: { id: string; value: string; inherited: string; required: boolean; onCommit: (v: string | undefined) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const t = draft.trim();
    if (t === value) return;
    if (t === '' && required) { setDraft(value); return; }
    onCommit(t === '' ? undefined : t);
  };
  return (
    <input data-testid={`control-style-font-${id}`} aria-label={`${id} font`} value={draft} placeholder={inherited} onChange={e => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') commit(); }} className="w-full text-xs rounded-lg border px-2 py-1"
      style={{ background: 'var(--surface-1)', borderColor: 'var(--border)', color: 'var(--text-primary)' }} />
  );
}

/** The built-in named styles: each one's own font and size. A blank field inherits (shown as the placeholder); Normal must have both. */
export function StylesSection({ format, onChange }: { format: DocFormat | null; onChange: (f: DocFormat) => void }) {
  const f = baseFormat(format);
  const builtin = new Set<string>(builtinStyleIds());
  const others = Object.keys(f.styles).filter(id => !builtin.has(id)).length;
  return (
    <div className="space-y-2">
      {builtinStyleIds().map(id => {
        const own = f.styles[id], eff = resolveStyle(f, id), required = id === 'normal';
        return (
          <div key={id} data-testid={`style-${id}`} className="grid grid-cols-[1fr_5rem] gap-2 items-end">
            <div>
              <p className="text-[11px] font-semibold mb-0.5" style={{ color: 'var(--text-primary)' }}>{styleName(f, id)}</p>
              <FamilyField id={id} value={own?.fontFamily ?? ''} inherited={eff.fontFamily} required={required} onCommit={v => onChange(withStyleField(f, id, { fontFamily: v }))} />
            </div>
            <NumField id={`style-size-${id}`} label="Size" unit="pt" step={0.5} value={own?.fontSizePt ?? (required ? eff.fontSizePt : null)}
              parse={t => (t.trim() === '' && !required ? null : parseBounded(t, FONT_RANGE.min, FONT_RANGE.max) ?? undefined)}
              onCommit={v => onChange(withStyleField(f, id, { fontSizePt: v ?? undefined }))} rule={`Enter ${FONT_RANGE.min} to ${FONT_RANGE.max} points${required ? '' : ', or leave blank to inherit'}.`} />
          </div>
        );
      })}
      {others > 0 && <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{others} other style{others === 1 ? '' : 's'} from the imported document {others === 1 ? 'is' : 'are'} kept as they are.</p>}
    </div>
  );
}
