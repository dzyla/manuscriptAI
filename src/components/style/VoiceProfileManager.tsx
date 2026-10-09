import { useState } from 'react';
import { useAIStore } from '../../stores/useAIStore';
import { buildProfile, MIN_PROFILE_WORDS, RECOMMENDED_PROFILE_WORDS } from '../../services/proseAudit/profile';
import { useSourceStore } from '../../stores/useSourceStore';

export function VoiceProfileManager({ onBuilt }: { onBuilt?: (name: string) => void }) {
  const { aiSettings, setAiSettings } = useAIStore();
  const sources = useSourceStore(s => s.sources);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('My own writing');
  const [pasted, setPasted] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const profile = aiSettings.voiceProfile;

  const create = () => {
    setError(null);
    const samples = [pasted, ...sources.filter(s => picked.includes(s.id)).map(s => s.text)].filter(t => t.trim());
    try {
      const { profile: built, warning: w } = buildProfile(name.trim() || 'My own writing', samples);
      setAiSettings({ ...aiSettings, voiceProfile: built });
      setWarning(w ?? null);
      setOpen(false);
      setPasted('');
      setPicked([]);
      onBuilt?.(built.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const borderStyle = { borderColor: 'var(--border-subtle)' };

  return (
    <div className="rounded-xl border p-3 text-[11px]" style={borderStyle} data-testid="voice-profile">
      {profile ? (
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{profile.name}</div>
            <div className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
              {profile.sampleWords.toLocaleString()} words · {profile.summary.meanWords} words/sentence ·{' '}
              {profile.summary.pctOver35}% over 35
            </div>
          </div>
          <div className="flex gap-2">
            <button data-testid="control-voice-rebuild" className="text-[10px] font-semibold text-blue-600 hover:underline" onClick={() => setOpen(true)}>Rebuild</button>
            <button
              data-testid="control-voice-remove"
              className="text-[10px] font-semibold hover:underline"
              style={{ color: 'var(--text-tertiary)' }}
              onClick={() => setAiSettings({ ...aiSettings, voiceProfile: undefined })}
            >
              Remove
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <div style={{ color: 'var(--text-secondary)' }}>
            Comparing against a typical-writing baseline. Add your own writing for a profile that matches your voice.
          </div>
          <button
            data-testid="control-voice-samples"
            className="shrink-0 rounded-lg bg-stone-800 px-2.5 py-1 text-[11px] font-semibold text-white"
            onClick={() => setOpen(true)}
          >
            Add samples
          </button>
        </div>
      )}

      {warning && <div className="mt-2 text-[10px] text-amber-700">{warning}</div>}

      {open && (
        <div className="mt-3 space-y-2">
          <input
            className="w-full rounded-lg border px-2 py-1 text-[11px]"
            style={borderStyle}
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Profile name"
          />
          <textarea
            className="h-32 w-full rounded-lg border p-2 text-[11px]"
            style={borderStyle}
            value={pasted}
            onChange={e => setPasted(e.target.value)}
            placeholder={`Paste at least ${MIN_PROFILE_WORDS.toLocaleString()} words you wrote yourself (${RECOMMENDED_PROFILE_WORDS.toLocaleString()}+ is better).`}
          />
          {sources.length > 0 && (
            <div className="max-h-28 overflow-auto rounded-lg border p-2" style={borderStyle}>
              <div className="mb-1 text-[10px] font-semibold" style={{ color: 'var(--text-secondary)' }}>Or use uploaded files</div>
              {sources.map(s => (
                <label key={s.id} className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                  <input
                    type="checkbox"
                    checked={picked.includes(s.id)}
                    onChange={e => setPicked(p => (e.target.checked ? [...p, s.id] : p.filter(x => x !== s.id)))}
                  />
                  <span className="truncate">{s.name}</span>
                </label>
              ))}
            </div>
          )}
          {error && <div className="text-[10px] text-rose-600">{error}</div>}
          <div className="flex items-center gap-2">
            <button data-testid="control-voice-measure" className="rounded-lg bg-stone-800 px-2.5 py-1 text-[11px] font-semibold text-white" onClick={create}>
              Measure my voice
            </button>
            <button data-testid="control-voice-cancel" className="text-[11px]" style={{ color: 'var(--text-tertiary)' }} onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
