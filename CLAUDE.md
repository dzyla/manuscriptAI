# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm run dev          # Start Vite dev server at http://localhost:3000

# Build
npm run build        # Web build (output: dist/)
npm run build:electron  # Electron desktop build (output: release/ AppImage)

# Type-check and tests
npm run lint         # tsc --noEmit
npx vitest run       # 1858+ tests

# Clean
npm run clean        # rm -rf dist dist-electron
```

There are 1858+ vitest tests. The gate is three exit codes, all 0: `npx tsc --noEmit`, `npx vitest run`, `npm run build`. The exit code matters independently of the pass count: this suite once printed "passed" while exiting 1 because of an unhandled error in a pending timer. `vitest.config.ts` caps the pool at 2 forks (`maxForks: 2`) deliberately: one worker per core exhausted this machine's RAM. Never change or override it, and do not start a dev server or browser casually for the same reason. `npm run build` rewrites `dist-electron/`; revert that churn.

## Architecture Overview

This is a React 19 + TipTap rich-text editor for scientific manuscript writing, running as either a browser SPA or an Electron desktop app. The same source builds both targets via `vite-plugin-electron`.

### State Management (Zustand)

Three stores in `src/stores/` hold all runtime state:

- **`useDocumentStore`** — manuscript title, HTML content, save state, and citation registry (sourceId → citation number mapping). Owns all citation renumbering logic.
- **`useAIStore`** — AI settings, suggestions list, chat messages, and suggestion-apply history. AI settings are persisted to `localStorage`; everything else goes to Dexie.
- **`useSourceStore`** — uploaded/searched sources (PDFs, BibTeX, API results). Persisted to Dexie.

### Persistence (Dexie / IndexedDB)

`src/db/manuscriptDb.ts` defines a single Dexie database (`ManuscriptAIEditor`) with thirteen tables: `documents`, `sources`, `chatHistory`, `suggestions`, `historyItems`, `versionSnapshots`, `grantTemplates`, `assets`, `docxPackages`, `autosaveBackups`, `preservationStores`, `importBackupParts`, `importReports`. The document itself is persisted as ProseMirror JSON (schema versioned, loaded and saved through the document repository in `useDocumentStore`); HTML is derived. Imported DOCX provenance (OOXML preservation stores, original packages, images as `assets`) lives in its own tables, and `autosaveBackups` keep recoverable copies. Never add a node or mark attribute to the editor schema without checking `src/docx/preserve/hash.test.ts`: its golden hashes would silently switch the preservation layer off. All stores have `initialize()` methods that fall back to legacy `localforage` keys and then migrate data to Dexie on first run.

### AI Service (`src/services/ai.ts`)

All LLM calls go through this file. Key concepts:

- **Ten `AgentType`s** (`AGENT_INFO`): four core analysis agents, `manager` (Structure Architect), `editor` (Language Surgeon), `reviewer-2` (Reviewer 2), `researcher` (Clarity & Impact), run in parallel via `analyzeManuscript()`; the data agents `statistician`, `consistency` and `reporting` (advisory, flag-only); and `manuscript-ai` (chat), `literature-reviewer` and `citation-checker` (not offered as chat "reply as" agents).
- **Judge Agent**: runs after analysis, deduplicates overlapping suggestions by asking the LLM which is highest-impact.
- **Provider routing**: `gemini` uses `@google/genai`, `openai`/`anthropic`/`local` use the `openai` SDK pointed at the correct base URL. Anthropic and local are OpenAI-compatible.
- **Chunking**: For local LLMs, manuscript is split by section (configurable `localChunkSize`); cloud APIs receive the full text.
- **`digestApiSource()`**: Generates standalone source summaries without manuscript context — intentionally isolated to avoid the LLM summarizing the manuscript instead of the uploaded source.
- Custom agent prompts can override defaults (stored in `AISettings.customPrompts`).

### Editor (`src/components/Editor.tsx`)

TipTap editor with custom extensions in `src/extensions/`:

- **`SuggestionMark`** — highlights text spans that have pending suggestions
- **`AutoComplete`** — Tab-triggered AI autocomplete (uses assistant-prefill prompt pattern)
- **`GrammarChecker`** — passive grammar checking
- **`ResizableImage`** — draggable/resizable image nodes

The `@` key triggers a floating citation picker. Citations are schema nodes (`citation`, `src/extensions/specs/citation.ts`; an inline atom carrying `sourceIds`), not text: `[N]` is how a node renders and exports. Renumbering walks the ProseMirror doc in document order (`getCitationOrder` in `src/components/editor/useEditorHandle.ts`), never the HTML.

### The shell (`src/components/shell/`, `src/components/panels/`)

`App.tsx` composes `AppShell`: a top bar (`TopBar`, menus from `useTopBarItems`), a four-task rail (Write, Cite, Review, Format), one optional panel beside the page, the page canvas (`Editor`) and a `StatusBar`. `TaskPanels` hosts the panels for the active rail task and keeps the other three mounted (hidden) so their in-progress state survives; it also owns the chat composer (`useChatComposer`), which the Cite panel drives. Panels share one `Section` component (`keepMounted` defaults to true).

Where each old sidebar tab went:
- Outline and History tabs -> Write panel (`WritePanel`: Outline, History, Versions sections).
- Sources tab (uploads, search, BibTeX, Reference Manager) -> Cite panel (`CitePanel`, `panels/cite/`).
- Chat and Suggestions tabs, plus the style comparison -> Review panel (`ReviewPanel`: one document-ordered list of suggestions, style and grammar flags; Chat is a collapsible section, `panels/review/`).
- Style tab and page setup -> Format panel (`FormatPanel`: page setup, named styles, grant template).

Page numbers, the page limit and layout:
- All page numbers come from `src/services/pagination.ts`. Sub-project A3 replaces `estimatePages`' body and flips `approximate` to false with no UI change.
- The page limit is author-set (`DocFormat.pageLimitPages`). The app must never assert an NIH page limit of its own: real limits vary by activity code and funding announcement.
- `src/components/shell/reachability.test.tsx` is the contract for feature reachability. A feature that moves updates its row; one that is lost fails the suite. Update it whenever a feature moves. Rows catch deletions; its guards catch additions (a button with a title, a text-only button, an icon-only button, a duplicate test id, a top-bar menu item).
- **The reachability guards have limits.** They read the source of the guarded files, so they do not see a `<select>`, a checkbox, a `<div onClick>`, a button whose `title` is a bare variable, a templated test id (those are listed in `TEMPLATED_TESTIDS` and must be written out as literals to be checked), or anything in `src/extensions/views/*`. A new control of those kinds needs its row written by hand and a `data-testid`; nothing will fail if you forget. Give a new control a literal `data-testid="control-x"` and a row with `control:x`.
- The status bar carries the one live NIH compliance signal: the grant section furthest over its page budget (`useOverBudget`, `worstOverBudget` in `GrantPanel.tsx`). Keep it quiet when nothing is over.
- The page is the width (no width control); zoom is a CSS `zoom` on the page canvas, fit to the available width.

### Electron (`electron/main.ts`, `electron/preload.mjs`)

Main process handles IPC for CORS-bypassed network requests via Electron's `net` module. The renderer communicates via `contextBridge`. In the browser build, direct `fetch` is used instead.

## Key Conventions

- **Citation registry**: `citationRegistry` maps `sourceId → number`. The registry in the store and the numbers on the editor's `citation` nodes must stay in sync. After a structural change, ask the editor for the order (`editorRef.current.getCitationOrder()`), pass it to `useDocumentStore.renumberCitations(order)`, which returns the new **registry** (not HTML), and apply that with `editorRef.current.updateCitations(registry)` (see `renumberCitations` in `App.tsx`). Never scan or rewrite HTML to renumber.
- **Suggestion lifecycle**: suggestions are created with `startIndex`/`endIndex` offsets into the plain text. The `SuggestionMark` extension uses these to highlight ranges. On accept, `App.tsx` applies the text replacement and persists the history item.
- **Provider configuration**: `AIProvider` type is `'gemini' | 'openai' | 'anthropic' | 'local'`. All non-Gemini providers share the OpenAI SDK path; Anthropic uses `https://api.anthropic.com/v1` as base URL with the anthropic API key.
- **GitHub Pages deployment**: `vite.config.ts` sets `base: '/manuscriptAI/'` in production. Change this if the repo name differs.
- **Web Workers**: PDF and DOCX parsing run in `src/workers/pdfWorker.ts` and `src/workers/docxWorker.ts` via Comlink to avoid blocking the UI thread.
- **No backend**: this is a fully client-side app. There is no server process beyond the Vite dev server proxy (which proxies `/api/proxy?target=<url>` for CORS bypass in dev).
