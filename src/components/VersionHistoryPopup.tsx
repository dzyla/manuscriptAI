import { useState, useEffect, useCallback, useRef } from 'react';
import { db } from '../db/manuscriptDb';
import type { VersionSnapshot } from '../types';
import { Clock, Plus, Trash2, RotateCcw, Eye, X, History } from 'lucide-react';

interface VersionHistoryPopupProps {
  currentTitle: string;
  currentContent: string;
  onRestore: (snapshot: VersionSnapshot) => void;
}

function stripHtml(html: string) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function wc(html: string) {
  return stripHtml(html).split(/\s+/).filter(w => w.length > 0).length;
}

function formatDate(ts: number) {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function VersionHistoryPopup({ currentTitle, currentContent, onRestore }: VersionHistoryPopupProps) {
  const [open, setOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<VersionSnapshot[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [newName, setNewName] = useState('');
  const [showNameInput, setShowNameInput] = useState(false);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const loadSnapshots = useCallback(async () => {
    const all = await db.versionSnapshots.orderBy('timestamp').reverse().toArray();
    setSnapshots(all);
  }, []);

  useEffect(() => {
    if (open) loadSnapshots();
  }, [open, loadSnapshots]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const saveSnapshot = async () => {
    const name = newName.trim() || `Snapshot — ${new Date().toLocaleString()}`;
    setIsSaving(true);
    const snapshot: VersionSnapshot = {
      id: `snap-${Date.now()}`,
      name,
      timestamp: Date.now(),
      title: currentTitle,
      content: currentContent,
      wordCount: wc(currentContent),
    };
    await db.versionSnapshots.put(snapshot);
    setSnapshots(prev => [snapshot, ...prev]);
    setNewName('');
    setShowNameInput(false);
    setIsSaving(false);
  };

  const deleteSnapshot = async (id: string) => {
    await db.versionSnapshots.delete(id);
    setSnapshots(prev => prev.filter(s => s.id !== id));
    if (previewId === id) setPreviewId(null);
  };

  const previewSnapshot = snapshots.find(s => s.id === previewId);

  return (
    <div className="relative">
      {/* Trigger button */}
      <button
        ref={triggerRef}
        onClick={() => setOpen(v => !v)}
        title="Version History"
        className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold uppercase tracking-widest transition-all select-none"
        style={{
          background: open ? 'var(--surface-3)' : 'var(--surface-2)',
          color: open ? 'var(--text-secondary)' : 'var(--text-muted)',
          border: '1px solid var(--border)',
          letterSpacing: '0.08em',
        }}
      >
        <History size={11} strokeWidth={2.2} />
        <span className="hidden sm:inline">History</span>
      </button>

      {/* Floating panel */}
      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 top-full mt-2 z-50 flex flex-col rounded-xl shadow-2xl overflow-hidden"
          style={{
            width: '340px',
            maxHeight: '480px',
            background: 'var(--surface-1)',
            border: '1px solid var(--border)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)',
            animation: 'slideIn 0.18s ease-out',
          }}
        >
          {/* Panel header */}
          <div className="flex items-center justify-between px-4 py-2.5 shrink-0" style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}>
            <div className="flex items-center gap-2">
              <Clock size={13} style={{ color: 'var(--text-muted)' }} />
              <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>Version History</span>
              {snapshots.length > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style={{ background: 'var(--surface-3)', color: 'var(--text-muted)' }}>
                  {snapshots.length}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => { setShowNameInput(v => !v); setNewName(''); }}
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium transition-colors"
                style={{ background: 'var(--accent-blue-soft)', color: 'var(--accent-blue)' }}
                title="Save snapshot"
              >
                <Plus size={11} />
                Save
              </button>
              <button
                onClick={() => setOpen(false)}
                className="p-1 rounded-lg transition-colors"
                style={{ color: 'var(--text-muted)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-3)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <X size={13} />
              </button>
            </div>
          </div>

          {/* Name input */}
          {showNameInput && (
            <div className="px-3 py-2.5 flex gap-2 shrink-0" style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface-0)' }}>
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') saveSnapshot();
                  if (e.key === 'Escape') { setShowNameInput(false); setNewName(''); }
                }}
                placeholder={`Snapshot — ${new Date().toLocaleString()}`}
                className="flex-1 text-xs px-2.5 py-1.5 rounded-lg border focus:outline-none focus:ring-1"
                style={{
                  borderColor: 'var(--border)',
                  background: 'var(--surface-1)',
                  color: 'var(--text-primary)',
                  // @ts-ignore
                  '--tw-ring-color': 'var(--accent-blue)',
                }}
                autoFocus
              />
              <button
                onClick={saveSnapshot}
                disabled={isSaving}
                className="px-3 py-1.5 text-xs rounded-lg font-medium transition-colors shrink-0"
                style={{ background: 'var(--accent-blue)', color: '#fff', opacity: isSaving ? 0.6 : 1 }}
              >
                {isSaving ? '…' : 'Save'}
              </button>
            </div>
          )}

          {/* Snapshot list */}
          <div className="flex-1 overflow-y-auto">
            {snapshots.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 gap-2 text-center px-6">
                <Clock size={22} style={{ color: 'var(--text-muted)', opacity: 0.5 }} />
                <p className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>No snapshots yet</p>
                <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                  Save named snapshots to checkpoint your work before major revisions.
                </p>
              </div>
            ) : (
              <ul>
                {snapshots.map((snap, i) => (
                  <li
                    key={snap.id}
                    className="px-3.5 py-2.5 transition-colors"
                    style={{
                      borderBottom: i < snapshots.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-2)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{snap.name}</p>
                        <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                          {formatDate(snap.timestamp)}
                          <span className="mx-1 opacity-40">·</span>
                          {snap.wordCount ?? wc(snap.content)} words
                        </p>
                      </div>
                      <div className="flex gap-0.5 shrink-0 mt-0.5">
                        <button
                          onClick={() => setPreviewId(prev => prev === snap.id ? null : snap.id)}
                          className="p-1.5 rounded-lg transition-colors"
                          title="Preview"
                          style={{ color: 'var(--text-muted)' }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-3)')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        >
                          <Eye size={12} />
                        </button>
                        <button
                          onClick={() => {
                            if (window.confirm(`Restore snapshot "${snap.name}"? Current content will be replaced.`)) {
                              onRestore(snap);
                              setOpen(false);
                            }
                          }}
                          className="p-1.5 rounded-lg transition-colors"
                          title="Restore"
                          style={{ color: 'var(--text-muted)' }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-3)')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        >
                          <RotateCcw size={12} />
                        </button>
                        <button
                          onClick={() => { if (window.confirm(`Delete snapshot "${snap.name}"?`)) deleteSnapshot(snap.id); }}
                          className="p-1.5 rounded-lg transition-colors"
                          title="Delete"
                          style={{ color: 'var(--text-muted)' }}
                          onMouseEnter={e => {
                            e.currentTarget.style.background = 'rgba(196,61,92,0.08)';
                            e.currentTarget.style.color = 'var(--accent-rose)';
                          }}
                          onMouseLeave={e => {
                            e.currentTarget.style.background = 'transparent';
                            e.currentTarget.style.color = 'var(--text-muted)';
                          }}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* Full-screen preview modal — rendered outside the popup so it covers everything */}
      {previewSnapshot && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-6" style={{ background: 'rgba(0,0,0,0.55)' }}>
          <div
            className="relative flex flex-col rounded-2xl shadow-2xl w-full"
            style={{
              maxWidth: '760px',
              maxHeight: '82vh',
              background: 'var(--surface-1)',
              border: '1px solid var(--border)',
              animation: 'slideIn 0.2s ease-out',
            }}
          >
            <div className="flex items-center justify-between px-5 py-3 border-b shrink-0" style={{ borderColor: 'var(--border)' }}>
              <div>
                <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{previewSnapshot.name}</p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  {formatDate(previewSnapshot.timestamp)} · {previewSnapshot.wordCount ?? wc(previewSnapshot.content)} words
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    if (window.confirm(`Restore snapshot "${previewSnapshot.name}"?`)) {
                      onRestore(previewSnapshot);
                      setPreviewId(null);
                      setOpen(false);
                    }
                  }}
                  className="px-3 py-1.5 text-xs rounded-lg font-medium flex items-center gap-1.5 transition-colors"
                  style={{ background: 'var(--accent-blue)', color: '#fff' }}
                >
                  <RotateCcw size={11} /> Restore
                </button>
                <button
                  onClick={() => setPreviewId(null)}
                  className="p-1.5 rounded-lg transition-colors"
                  style={{ color: 'var(--text-muted)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-3)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <X size={15} />
                </button>
              </div>
            </div>
            <div
              className="flex-1 overflow-y-auto p-6 prose prose-sm max-w-none"
              dangerouslySetInnerHTML={{ __html: previewSnapshot.content }}
              style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-editor)' }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
