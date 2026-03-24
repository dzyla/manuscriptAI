import { motion, AnimatePresence } from 'motion/react';
import { X, Settings, Server, Zap, RotateCcw, Cloud } from 'lucide-react';
import { AISettings, AgentType } from '../types';
import { DEFAULT_AGENT_PROMPTS, AGENT_INFO, AGENT_ICONS } from '../services/ai';
import { useState, createElement } from 'react';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AISettings;
  onUpdateSettings: (settings: AISettings) => void;
}

function AgentIcon({ agent, size = 12 }: { agent: AgentType; size?: number }) {
  const info = AGENT_INFO[agent];
  const IconComponent = AGENT_ICONS[info?.iconName];
  if (!IconComponent) return null;
  return createElement(IconComponent, { size });
}

export default function SettingsModal({ isOpen, onClose, settings, onUpdateSettings }: SettingsModalProps) {
  const [activeSection, setActiveSection] = useState<'provider' | 'agents'>('provider');
  const allAgents: AgentType[] = ['manager', 'editor', 'reviewer-2', 'researcher'];

  const resetPrompt = (agent: AgentType) => {
    const newCustom = { ...settings.customPrompts };
    delete newCustom[agent];
    onUpdateSettings({ ...settings, customPrompts: newCustom });
  };

  const inputStyle = {
    background: 'var(--surface-2)', 
    border: '1px solid var(--border)', 
    color: 'var(--text-primary)'
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-stone-900/40 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            className="relative w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden"
            style={{ border: '1px solid var(--border)', maxHeight: '85vh', background: 'var(--surface-1)' }}
          >
            {/* Header */}
            <div className="p-5 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <div className="flex items-center gap-2">
                <Settings size={18} style={{ color: 'var(--text-muted)' }} />
                <h2 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>AI Configuration</h2>
              </div>
              <button onClick={onClose} className="p-2 rounded-lg hover:bg-stone-50 transition-colors" style={{ color: 'var(--text-muted)' }}>
                <X size={18} />
              </button>
            </div>

            {/* Section tabs */}
            <div className="flex px-5 pt-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <button
                onClick={() => setActiveSection('provider')}
                className={`px-3 py-2.5 text-xs font-semibold transition-colors flex items-center gap-1.5 ${activeSection === 'provider' ? 'border-b-2 border-stone-800' : ''}`}
                style={{ color: activeSection === 'provider' ? 'var(--text-primary)' : 'var(--text-tertiary)' }}
              >
                <Server size={12} /> Provider
              </button>
              <button
                onClick={() => setActiveSection('agents')}
                className={`px-3 py-2.5 text-xs font-semibold transition-colors flex items-center gap-1.5 ${activeSection === 'agents' ? 'border-b-2 border-stone-800' : ''}`}
                style={{ color: activeSection === 'agents' ? 'var(--text-primary)' : 'var(--text-tertiary)' }}
              >
                <Zap size={12} /> Agent Prompts
              </button>
            </div>

            <div className="overflow-y-auto" style={{ maxHeight: 'calc(85vh - 160px)' }}>
              <div className="p-5 space-y-5">
                {activeSection === 'provider' ? (
                  <>
                    <div className="space-y-3">
                      <label className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Provider</label>
                      <div className="grid grid-cols-4 gap-2">
                        {([
                          { key: 'gemini' as const, icon: <Zap size={16} />, label: 'Gemini' },
                          { key: 'openai' as const, icon: <Server size={16} />, label: 'OpenAI' },
                          { key: 'anthropic' as const, icon: <Cloud size={16} />, label: 'Claude' },
                          { key: 'local' as const, icon: <Server size={16} />, label: 'Local' },
                        ]).map(p => (
                          <button
                            key={p.key}
                            onClick={() => onUpdateSettings({ ...settings, provider: p.key })}
                            className={`flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl border-2 transition-all ${
                              settings.provider === p.key 
                                ? 'border-stone-800' 
                                : 'hover:border-stone-300'
                            }`}
                            style={{ 
                              color: settings.provider === p.key ? 'var(--text-primary)' : 'var(--text-muted)',
                              background: settings.provider === p.key ? 'var(--surface-2)' : 'transparent',
                              borderColor: settings.provider === p.key ? undefined : 'var(--border-subtle)',
                            }}
                          >
                            {p.icon}
                            <span className="font-medium text-xs">{p.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    {settings.provider === 'gemini' && (
                      <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="space-y-3">
                        <div className="space-y-1.5">
                          <label className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Gemini API Key</label>
                          <input
                            type="password"
                            value={settings.geminiApiKey || ''}
                            onChange={(e) => onUpdateSettings({ ...settings, geminiApiKey: e.target.value })}
                            placeholder="Optional, overrides .env key"
                            className="w-full p-3 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-stone-800/10 transition-all"
                            style={inputStyle}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Model Name</label>
                          <input
                            type="text"
                            value={settings.geminiModel || ''}
                            onChange={(e) => onUpdateSettings({ ...settings, geminiModel: e.target.value })}
                            placeholder="gemini-3.1-pro-preview"
                            className="w-full p-3 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-stone-800/10 transition-all"
                            style={inputStyle}
                          />
                        </div>

                      </motion.div>
                    )}

                    {settings.provider === 'openai' && (
                      <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="space-y-3">
                        <div className="space-y-1.5">
                          <label className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>OpenAI API Key</label>
                          <input
                            type="password"
                            value={settings.openaiApiKey || ''}
                            onChange={(e) => onUpdateSettings({ ...settings, openaiApiKey: e.target.value })}
                            placeholder="sk-..."
                            className="w-full p-3 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-stone-800/10 transition-all"
                            style={inputStyle}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Model Name</label>
                          <input
                            type="text"
                            value={settings.openaiModel || ''}
                            onChange={(e) => onUpdateSettings({ ...settings, openaiModel: e.target.value })}
                            placeholder="gpt-5.4-mini"
                            className="w-full p-3 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-stone-800/10 transition-all"
                            style={inputStyle}
                          />
                        </div>

                      </motion.div>
                    )}

                    {settings.provider === 'anthropic' && (
                      <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="space-y-3">
                        <div className="space-y-1.5">
                          <label className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Anthropic API Key</label>
                          <input
                            type="password"
                            value={settings.anthropicApiKey || ''}
                            onChange={(e) => onUpdateSettings({ ...settings, anthropicApiKey: e.target.value })}
                            placeholder="sk-ant-..."
                            className="w-full p-3 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-stone-800/10 transition-all"
                            style={inputStyle}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Model Name</label>
                          <input
                            type="text"
                            value={settings.anthropicModel || ''}
                            onChange={(e) => onUpdateSettings({ ...settings, anthropicModel: e.target.value })}
                            placeholder="claude-sonnet-4-6"
                            className="w-full p-3 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-stone-800/10 transition-all"
                            style={inputStyle}
                          />
                        </div>

                        <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          Requires CORS-enabled browser or proxy for direct browser access.
                        </p>
                      </motion.div>
                    )}

                    {settings.provider === 'local' && (
                      <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="space-y-3">
                        <div className="space-y-1.5">
                          <label className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Base URL</label>
                          <input
                            type="text"
                            value={settings.localBaseUrl}
                            onChange={(e) => onUpdateSettings({ ...settings, localBaseUrl: e.target.value })}
                            placeholder="http://localhost:11434/v1"
                            className="w-full p-3 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-stone-800/10 transition-all"
                            style={inputStyle}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>API Key</label>
                          <input
                            type="password"
                            value={settings.localApiKey}
                            onChange={(e) => onUpdateSettings({ ...settings, localApiKey: e.target.value })}
                            placeholder="Optional"
                            className="w-full p-3 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-stone-800/10 transition-all"
                            style={inputStyle}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Model Name</label>
                          <input
                            type="text"
                            value={settings.localModel}
                            onChange={(e) => onUpdateSettings({ ...settings, localModel: e.target.value })}
                            placeholder="llama3, mistral, etc."
                            className="w-full p-3 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-stone-800/10 transition-all"
                            style={inputStyle}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Context / Chunking</label>
                          <select
                            value={settings.localChunkSize === 0 ? '0' : String(settings.localChunkSize ?? 2000)}
                            onChange={(e) => onUpdateSettings({ ...settings, localChunkSize: Number(e.target.value) })}
                            className="w-full p-3 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-stone-800/10 transition-all"
                            style={inputStyle}
                          >
                            <option value="0">No chunking — full manuscript (large context models)</option>
                            <option value="1000">Small chunks — 1000 chars (small models, 4k ctx)</option>
                            <option value="2000">Default chunks — 2000 chars (8k ctx models)</option>
                            <option value="4000">Large chunks — 4000 chars (16k ctx models)</option>
                            <option value="8000">XL chunks — 8000 chars (32k+ ctx models)</option>
                          </select>
                        </div>
                        <div className="p-3 rounded-lg text-[10px] leading-relaxed space-y-1" style={{ background: 'var(--surface-2)', color: 'var(--text-tertiary)' }}>
                          <p className="font-semibold" style={{ color: 'var(--text-secondary)' }}>Local LLM Tips:</p>
                          <p>• Set "No chunking" for models with 32k+ context (Qwen2.5, Llama 3.1 70B, etc.)</p>
                          <p>• Parallel mode runs all agents simultaneously (CPU/GPU intensive!)</p>
                          <p>• If parallel mode causes crashes, run agents one by one from Analyze menu</p>
                          <p>• Recommended: use 7B+ models for best suggestion quality</p>
                        </div>
                      </motion.div>
                    )}
                  </>
                ) : (
                  <div className="space-y-4">
                    <div>
                      <h3 className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>Agent Personalities</h3>
                      <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                        Customize each agent's system prompt to tune behavior and focus areas.
                      </p>
                    </div>
                    {allAgents.map((agent) => (
                      <div key={agent} className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <AgentIcon agent={agent} size={12} />
                            <label className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>
                              {AGENT_INFO[agent].label}
                            </label>
                          </div>
                          {settings.customPrompts?.[agent] && (
                            <button
                              onClick={() => resetPrompt(agent)}
                              className="flex items-center gap-1 text-[9px] font-semibold px-1.5 py-0.5 rounded hover:bg-stone-50 transition-colors"
                              style={{ color: 'var(--text-muted)' }}
                              title="Reset to default"
                            >
                              <RotateCcw size={10} /> Reset
                            </button>
                          )}
                        </div>
                        <textarea
                          className="w-full p-2.5 rounded-lg text-[11px] min-h-[80px] focus:outline-none focus:ring-1 focus:ring-stone-400 resize-y leading-relaxed"
                          style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
                          value={settings.customPrompts?.[agent] ?? DEFAULT_AGENT_PROMPTS[agent]}
                          onChange={(e) => onUpdateSettings({
                            ...settings,
                            customPrompts: { ...settings.customPrompts, [agent]: e.target.value }
                          })}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="p-5" style={{ background: 'var(--surface-2)', borderTop: '1px solid var(--border-subtle)' }}>
              <button
                onClick={onClose}
                className="w-full py-2.5 bg-stone-800 text-white rounded-xl font-semibold text-sm hover:bg-stone-700 transition-colors shadow-sm"
              >
                Save Configuration
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
