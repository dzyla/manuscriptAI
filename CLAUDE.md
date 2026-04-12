# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm run dev          # Start Vite dev server at http://localhost:3000

# Build
npm run build        # Web build (output: dist/)
npm run build:electron  # Electron desktop build (output: release/ AppImage)

# Type-check (no dedicated test runner)
npm run lint         # tsc --noEmit

# Clean
npm run clean        # rm -rf dist dist-electron
```

There are no automated tests. Type-checking via `npm run lint` is the primary correctness gate.

## Architecture Overview

This is a React 19 + TipTap rich-text editor for scientific manuscript writing, running as either a browser SPA or an Electron desktop app. The same source builds both targets via `vite-plugin-electron`.

### State Management (Zustand)

Three stores in `src/stores/` hold all runtime state:

- **`useDocumentStore`** — manuscript title, HTML content, save state, and citation registry (sourceId → citation number mapping). Owns all citation renumbering logic.
- **`useAIStore`** — AI settings, suggestions list, chat messages, and suggestion-apply history. AI settings are persisted to `localStorage`; everything else goes to Dexie.
- **`useSourceStore`** — uploaded/searched sources (PDFs, BibTeX, API results). Persisted to Dexie.

### Persistence (Dexie / IndexedDB)

`src/db/manuscriptDb.ts` defines a single Dexie database (`ManuscriptAIEditor`) with six tables: `documents`, `sources`, `chatHistory`, `suggestions`, `historyItems`, `versionSnapshots`. All stores have `initialize()` methods that fall back to legacy `localforage` keys and then migrate data to Dexie on first run.

### AI Service (`src/services/ai.ts`)

All LLM calls go through this file. Key concepts:

- **Four analysis agents**: `manager` (Structure Architect), `editor` (Language Surgeon), `reviewer-2` (Reviewer 2), `researcher` (Clarity & Impact). These run in parallel via `analyzeManuscript()`.
- **Judge Agent**: runs after analysis, deduplicates overlapping suggestions by asking the LLM which is highest-impact.
- **Provider routing**: `gemini` uses `@google/genai`, `openai`/`anthropic`/`local` use the `openai` SDK pointed at the correct base URL. Anthropic and local are OpenAI-compatible.
- **Chunking**: For local LLMs, manuscript is split by section (configurable `localChunkSize`); cloud APIs receive the full text.
- **`digestApiSource()`**: Generates standalone source summaries without manuscript context — intentionally isolated to avoid the LLM summarizing the manuscript instead of the uploaded source.
- Custom agent prompts can override defaults (stored in `AISettings.customPrompts`).

### Editor (`src/components/Editor.tsx`)

TipTap editor with custom extensions in `src/extensions/`:

- **`CitationNode`** — renders `[N]` citation markers
- **`SuggestionMark`** — highlights text spans that have pending suggestions
- **`AutoComplete`** — Tab-triggered AI autocomplete (uses assistant-prefill prompt pattern)
- **`GrammarChecker`** — passive grammar checking
- **`ResizableImage`** — draggable/resizable image nodes

The `@` key triggers a floating citation picker. Citation numbers are plain text `[N]` patterns in HTML; renumbering scans the full HTML in document order.

### Sidebar (`src/components/Sidebar.tsx`)

Four tabs: Chat, Suggestions, Sources, History. The Sources tab contains the file uploader (PDF/DOCX via Web Workers in `src/workers/`), semantic literature search client (`src/services/manuscriptSearch.ts`), BibTeX parsing (`src/services/citations.ts`), and the Reference Manager panel.

### Electron (`electron/main.ts`, `electron/preload.mjs`)

Main process handles IPC for CORS-bypassed network requests via Electron's `net` module. The renderer communicates via `contextBridge`. In the browser build, direct `fetch` is used instead.

## Key Conventions

- **Citation registry**: `citationRegistry` maps `sourceId → number`. The registry in the store and `[N]` markers in HTML must stay in sync. Always call `useDocumentStore.renumberCitations()` after structural changes and apply the returned `newHtml` to the editor.
- **Suggestion lifecycle**: suggestions are created with `startIndex`/`endIndex` offsets into the plain text. The `SuggestionMark` extension uses these to highlight ranges. On accept, `App.tsx` applies the text replacement and persists the history item.
- **Provider configuration**: `AIProvider` type is `'gemini' | 'openai' | 'anthropic' | 'local'`. All non-Gemini providers share the OpenAI SDK path; Anthropic uses `https://api.anthropic.com/v1` as base URL with the anthropic API key.
- **GitHub Pages deployment**: `vite.config.ts` sets `base: '/manuscriptAI/'` in production. Change this if the repo name differs.
- **Web Workers**: PDF and DOCX parsing run in `src/workers/pdfWorker.ts` and `src/workers/docxWorker.ts` via Comlink to avoid blocking the UI thread.
- **No backend**: this is a fully client-side app. There is no server process beyond the Vite dev server proxy (which proxies `/api/proxy?target=<url>` for CORS bypass in dev).
