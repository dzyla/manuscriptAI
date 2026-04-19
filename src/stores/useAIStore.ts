import { create } from 'zustand';
import { db } from '../db/manuscriptDb';
import type { AISettings, Suggestion, Message, HistoryItem } from '../types';
import * as secureStorage from '../services/secureStorage';

const DEFAULT_AI_SETTINGS: AISettings = {
  provider: 'local',
  geminiApiKey: '',
  openaiApiKey: '',
  anthropicApiKey: '',
  geminiModel: 'gemini-3.1-pro-preview',
  openaiModel: 'gpt-5.4-mini',
  anthropicModel: 'claude-sonnet-4-6',
  localBaseUrl: 'http://localhost:1234/v1/chat/completions',
  localApiKey: '',
  localModel: 'local-model',
};

const DEFAULT_WELCOME_MSG: Message = {
  id: '1',
  role: 'assistant',
  content: "Welcome! I'm your AI Manuscript Manager. Click \"Analyze All\" to get feedback from our specialized agents — Language Surgeon, Reviewer 2, and Clarity & Impact — or chat with any agent individually.",
  agent: 'manager',
};

interface AIState {
  aiSettings: AISettings;
  isAnalyzing: boolean;
  suggestions: Suggestion[];
  messages: Message[];
  history: HistoryItem[];
  analysisProgress: { agent: string; total: number; done: number } | null;

  setAiSettings: (s: AISettings) => void;
  setIsAnalyzing: (v: boolean) => void;
  setAnalysisProgress: (p: AIState['analysisProgress']) => void;

  addSuggestions: (newSuggestions: Suggestion[]) => void;
  setSuggestions: (suggestions: Suggestion[]) => void;
  removeSuggestion: (id: string) => void;
  clearSuggestions: () => void;
  updateSuggestion: (id: string, patch: Partial<Suggestion>) => void;

  addMessage: (msg: Message) => void;
  setMessages: (msgs: Message[]) => void;
  updateMessageSuggestions: (removedId: string) => void;

  addHistoryItem: (item: HistoryItem) => void;
  removeHistoryItem: (id: string) => void;
  setHistory: (items: HistoryItem[]) => void;

  /** Load from Dexie, migrating from localforage if needed. */
  initialize: () => Promise<void>;

  persistSuggestions: () => Promise<void>;
  persistMessages: () => Promise<void>;
  persistHistory: () => Promise<void>;
}

export const useAIStore = create<AIState>((set, get) => ({
  aiSettings: DEFAULT_AI_SETTINGS,
  isAnalyzing: false,
  suggestions: [],
  messages: [DEFAULT_WELCOME_MSG],
  history: [],
  analysisProgress: null,

  setAiSettings: (aiSettings) => set({ aiSettings }),
  setIsAnalyzing: (isAnalyzing) => set({ isAnalyzing }),
  setAnalysisProgress: (analysisProgress) => set({ analysisProgress }),

  addSuggestions: (newSuggestions) => set((state) => ({
    suggestions: [...state.suggestions, ...newSuggestions].sort((a, b) => a.startIndex - b.startIndex),
  })),
  setSuggestions: (suggestions) => set({ suggestions }),
  removeSuggestion: (id) => set((state) => ({
    suggestions: state.suggestions.filter(s => s.id !== id),
    messages: state.messages.map(msg => ({
      ...msg,
      suggestions: msg.suggestions?.filter(s => s.id !== id),
    })),
  })),
  clearSuggestions: () => set((state) => ({
    suggestions: [],
    messages: state.messages.map(msg => ({ ...msg, suggestions: [] })),
  })),
  updateSuggestion: (id, patch) => set((state) => ({
    suggestions: state.suggestions.map(s => s.id === id ? { ...s, ...patch } : s),
  })),

  addMessage: (msg) => set((state) => ({ messages: [...state.messages, msg] })),
  setMessages: (messages) => set({ messages }),
  updateMessageSuggestions: (removedId) => set((state) => ({
    messages: state.messages.map(msg => ({
      ...msg,
      suggestions: msg.suggestions?.filter(s => s.id !== removedId),
    })),
  })),

  addHistoryItem: (item) => set((state) => ({ history: [...state.history, item] })),
  removeHistoryItem: (id) => set((state) => ({ history: state.history.filter(h => h.id !== id) })),
  setHistory: (history) => set({ history }),

  initialize: async () => {
    try {
      // One-time migration from localStorage → encrypted Electron store
      await secureStorage.migrateFromLocalStorage('manuscript-ai-settings');
      // Load AI settings from secure storage (encrypted in Electron, localStorage in browser)
      const settingsJson = await secureStorage.getItem('manuscript-ai-settings');
      if (settingsJson) {
        try {
          const saved = JSON.parse(settingsJson);
          set({ aiSettings: { ...DEFAULT_AI_SETTINGS, ...saved } });
        } catch {}
      }

      // Load suggestions from Dexie
      const suggestions = await db.suggestions.toArray();
      if (suggestions.length > 0) {
        set({ suggestions: suggestions.sort((a, b) => a.startIndex - b.startIndex) });
      }

      // Load messages from Dexie
      const chatRows = await db.chatHistory.orderBy('order').toArray();
      if (chatRows.length > 0) {
        set({ messages: chatRows.map(r => r.message) });
      }

      // Load history from Dexie
      const histItems = await db.historyItems.orderBy('timestamp').toArray();
      if (histItems.length > 0) {
        set({ history: histItems });
      }

      // Try migrating from legacy localforage
      if (suggestions.length === 0 && chatRows.length === 0) {
        const localforage = await import('localforage');
        const data: any = await localforage.default.getItem('manuscript-ai-editor-autosave');
        if (data) {
          if (data.suggestions?.length) {
            set({ suggestions: data.suggestions });
            await get().persistSuggestions();
          }
          if (data.messages?.length) {
            set({ messages: data.messages });
            await get().persistMessages();
          }
          if (data.history?.length) {
            set({ history: data.history });
            await get().persistHistory();
          }
          if (data.aiSettings) {
            const merged = { ...DEFAULT_AI_SETTINGS, ...data.aiSettings };
            set({ aiSettings: merged });
            await secureStorage.setItem('manuscript-ai-settings', JSON.stringify(merged));
          }
        }
      }
    } catch (err) {
      console.error('AIStore.initialize failed:', err);
    }
  },

  persistSuggestions: async () => {
    const { suggestions } = get();
    await db.suggestions.clear();
    if (suggestions.length > 0) await db.suggestions.bulkPut(suggestions);
  },

  persistMessages: async () => {
    const { messages } = get();
    await db.chatHistory.clear();
    if (messages.length > 0) {
      await db.chatHistory.bulkPut(
        messages.map((message, order) => ({ id: message.id, message, order }))
      );
    }
  },

  persistHistory: async () => {
    const { history } = get();
    await db.historyItems.clear();
    if (history.length > 0) await db.historyItems.bulkPut(history);
  },
}));
