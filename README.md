# Manuscript AI Editor

An AI-powered writing assistant for scientific manuscripts, built as a desktop app (Electron) and web app (React + TipTap).

By [Dawid Zyla](https://github.com/dzyla/manuscriptAI) — github.com/dzyla/manuscriptAI

![License](https://img.shields.io/badge/license-MIT-blue) ![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue) ![React](https://img.shields.io/badge/React-19-blue)

---

## Overview

Manuscript AI Editor is a full-featured scientific writing environment that combines a rich-text editor with a multi-agent AI review pipeline, a literature source manager, and a numeric citation system. It runs locally as an Electron desktop app or in any browser (e.g., GitHub Pages), and works with any OpenAI-compatible API — local LLMs (Ollama, LM Studio), Google Gemini, OpenAI, or Anthropic Claude.

---

## How the Editor Works

### Writing

The editor is built on [TipTap](https://tiptap.dev/) and supports full rich-text formatting: headings, bold/italic/underline, lists, text alignment, and undo history. Start from an IMRAD template (**New Manuscript**) or paste an existing draft.

The left rail shows an **outline** of your document headings. Clicking any heading scrolls to it instantly.

### Agent Analysis Pipeline

Click **Analyze All** to run specialized AI agents against your manuscript simultaneously:

```
Your Manuscript
      │
      ├──► Structure Architect  ──► IMRAD structure, logic gaps, section flow
      ├──► Language Surgeon     ──► Grammar, concision, passive voice, tense
      ├──► Reviewer 2           ──► Scientific rigor, unsupported claims
      └──► Clarity & Impact     ──► Buried findings, weak topic sentences
                                          │
                                          ▼
                                    Judge Agent (background)
                                    Deduplicates overlapping suggestions
                                          │
                                          ▼
                                  Suggestions Panel
```

Each agent has a distinct, non-overlapping scope. After suggestions arrive, a **Judge Agent** runs automatically: it groups suggestions that target the same passage, asks the LLM which is highest-impact, and removes the rest. The final list stays focused and actionable.

**Analyze Section** runs the same pipeline on only the section your cursor is in.

For **local LLMs**, the manuscript is split by section before sending (configurable chunk size) to respect context limits. For cloud APIs, the full text is sent in one request.

### Suggestions Panel

Each suggestion card shows:
- The original text and proposed replacement (with diff highlighting)
- Severity: `critical` / `major` / `minor` / `style`
- Category: grammar, flow, evidence, clarity, structure, etc.
- The agent that produced it

Click **Accept** to apply the change directly to the document. Click **Reject** to dismiss it. You can also add a **rebuttal** (a note explaining why you disagree) — the agent will respond. Click anywhere in a highlighted passage in the editor to jump to that suggestion card in the sidebar.

**Accept All / Reject All** process all pending suggestions in one click.

### Bubble Menu (Selected Text)

Select any text to open a floating action menu:

| Action | Agent | What it does |
|--------|-------|-------------|
| Polish | Language Surgeon | Grammar + tightening |
| Shorten | Language Surgeon | Cut for concision |
| Critique | Reviewer 2 | Find weaknesses |
| Strengthen | Reviewer 2 | Better evidence/argument |
| Sharpen | Clarity & Impact | Stronger topic sentence |
| Explain | Clarity & Impact | Clearer exposition |

**Rewrite** fully rewrites the selected passage. **Thesaurus** (single word) shows synonyms from the LLM. All bubble actions produce accept/reject suggestion cards, not chat messages.

---

## Chat

The **Chat** tab gives direct conversational access to the AI agents. Two scope modes control how much manuscript context is sent:

| Mode | What is sent |
|------|-------------|
| **Full Manuscript** | The entire document text |
| **Current Section** | Only the section your cursor is in |

Toggle scope using the manuscript/section buttons in the chat input area.

You can also attach individual **sources** from your library to the chat — PDFs, papers from search, or uploaded documents. Only the sources you explicitly tick are included in the prompt.

### Chat Agents

| Agent | Best for |
|-------|---------|
| **Manuscript AI** | Open-ended scholarly discussion, questions about the draft, general feedback |
| **Reviewer 2** | Anticipating peer review objections |
| **Literature Reviewer** | Discussing a specific uploaded source in relation to your manuscript |
| **Citation Checker** | Finding claims that likely need a reference |

The **Agents** mode (toggle in the chat toolbar) adds access to the full structured agent pipeline from the chat interface.

---

## Sources

The **Sources** tab manages reference material. All uploaded content is persisted via `localforage` (IndexedDB) and survives page reloads.

### Uploading Files

Drag files onto the drop zone or click Browse. Accepted formats:

| Format | How it is parsed |
|--------|-----------------|
| `.pdf` | PDF.js extracts text; heuristic cleaning removes page numbers, download notices, copyright lines, and artifact fragments |
| `.docx` | Mammoth extracts plain text from the Word document body |
| `.txt` / `.md` | Read directly as plain text |
| `.bib` | Parsed as a BibTeX library via citation-js |

After upload, PDF and text sources are automatically **AI-digested**: the LLM reads the source and produces a structured summary (Research Objective, Key Findings, Methods/Approach, Significance) without referencing your current manuscript. This digest is what you see in the source card and what is sent to agents when you attach the source to chat.

### Semantic Literature Search

Below the upload zone, a **Find Manuscripts** search box connects to the `manuscript-search.org` API — a semantic search index covering PubMed, bioRxiv, medRxiv, and arXiv. Type any query (title keywords, abstract-style text, a research question) and get ranked results with title, authors, journal, year, and relevance score.

Each result can be:
- **Added as a source** — the abstract is stored as a source in your library
- **BibTeX copied** — one-click copy of a formatted `.bib` entry

### PDF-to-Database Matching

When a PDF is uploaded, the app uses the AI digest (not the raw extracted text) to search the literature database. If a match is found above threshold, the source card shows a confirmation prompt listing up to 10 candidates. You can:
- Accept a match → the card gains the full metadata (title, authors, journal, DOI) above the AI summary
- Reject all candidates and search manually using the per-source search box

This matching flow works because the digest is a clean semantic signal; raw PDF text tends to be noisy (page numbers, footers, column artifacts).

### How References Are Fetched

```
Upload PDF / .docx / .txt / .md
          │
          ▼
    Text extracted locally
    (PDF.js for PDFs, Mammoth for .docx)
          │
          ▼
    Heuristic cleaning (PDFs)
    — page numbers, copyright lines,
      download notices, short artifacts
          │
          ▼
    AI Digest (no manuscript context)
    — Research Objective
    — Key Findings
    — Methods/Approach
    — Significance
          │
          ├──► Stored as source card (digest shown to user)
          │
          └──► Digest text used as search query
                    │
                    ▼
              manuscript-search.org API
              (HTTPS, semantic vector search)
                    │
                    ▼
              Top 10 database matches
              — confirm or skip match
                    │
                    ▼
              If matched: title / authors /
              journal / DOI populated
              on source card
```

The search API call goes through Electron's main-process `net` module when running as a desktop app (bypassing CORS), and directly via `fetch` in the browser.

### BibTeX Library

Upload a `.bib` file to unlock:
- **Citation health check**: cross-references in-text author-year citations against the `.bib` entries and flags orphaned citations (cited in text but not in `.bib`) and unused entries (in `.bib` but never cited)
- **Bibliography formatter**: renders the full reference list in APA 7th, Vancouver, Harvard, IEEE, or Nature style and inserts it into your manuscript

### Reference Manager

The **Reference Manager** panel appears when numeric citations `[1]`, `[2]`, etc. are present in the document. It shows a numbered list of all cited sources, with title, author, DOI link, and a remove button for each.

**Sync order** renumbers all `[N]` markers in the document in the order they first appear — useful after inserting new citations in the middle of the text.

**Insert reference list** appends a formatted `References` section to the end of the manuscript using the matched metadata (or filename as fallback).

### Numeric Citation Picker

In the editor, type `@` to open a floating citation picker. Start typing to filter sources by title or filename. Select a source to insert `[N]` at the cursor, where N is the next available citation number. The reference is registered in the Reference Manager immediately.

```
Type @  ──► floating picker appears
            │
            filter by title/filename
            │
            select source
            │
            ▼
        [N] inserted at cursor
        source registered in Reference Manager
```

If you insert a citation before existing ones (e.g., insert `[1]` in the introduction when the conclusion already has `[1]` and `[2]`), **Sync order** renumbers everything correctly.

---

## Post-Drafting Tools

Click the **Book** icon in the left rail to open the **Post-Drafting Assistant**:

- **Rebuttal Letter**: paste reviewer comments and generate a structured, professional point-by-point rebuttal
- **Cover Letter**: generate a journal-submission cover letter tailored to your manuscript and a specified target journal

---

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- npm
- An AI API key — or a local LLM server ([LM Studio](https://lmstudio.ai/) / [Ollama](https://ollama.com/))

### Web App

```bash
git clone https://github.com/dzyla/manuscriptAI
cd manuscript-ai-editor
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Desktop App (Electron)

```bash
npm run build:electron
```

Produces an AppImage for Linux in `release/`. Configure `electron-builder` in `package.json` for Windows/macOS targets.

---

## Configure AI Provider

Click **Settings** (gear icon, bottom-left) to configure your provider:

| Provider | What to set |
|----------|------------|
| **Local LLM** (default) | Base URL, e.g. `http://localhost:1234/v1/chat/completions`; model name |
| **Google Gemini** | [Gemini API key](https://makersuite.google.com/app/apikey); model name |
| **OpenAI** | [OpenAI API key](https://platform.openai.com/api-keys); model name |
| **Anthropic Claude** | [Anthropic API key](https://console.anthropic.com/settings/keys); model name |

All API keys are stored in browser `localStorage` and never leave your machine.

### Recommended Local Models

The app has been tested extensively with local models. Smaller models in the 4–8B range run very fast on consumer hardware and produce good-quality suggestions for most manuscripts.

#### Fast 4B models — great for everyday use

| Model | Speed (approx.) | Vision | Notes |
|-------|----------------|--------|-------|
| **NVIDIA Nemotron-3 Nano 4B** | ~180 tok/s | No | Fastest tested; excellent grammar and flow suggestions |
| **Google Gemma 3 4B** | ~140 tok/s | Yes | Slightly slower, but supports image analysis in chat |

Both models are available in LM Studio and Ollama and run comfortably on a modern GPU with 8 GB VRAM. They handle the structured JSON output required by the analysis pipeline reliably.

#### Larger models — higher quality, slower throughput

| Model | Vision | Notes |
|-------|--------|-------|
| **Qwen 2.5 7B / 14B** | Some variants | Strong reasoning, good JSON compliance |
| **Qwen2-VL 7B** | Yes | Excellent for figure analysis |
| **GLM-4 9B** | No | Good scientific writing style |
| **Llama 3.1 8B / 70B** | No | Solid all-rounder |

Larger models generally produce higher-quality suggestions but may be slower depending on hardware. If JSON parse errors appear, switch to a larger model or a cloud API.

#### General tips

- Set **Chunk size** in Settings to control how many characters are sent per section (0 = full manuscript in one request; not recommended for models with short context windows)
- Smaller models (< 3B) may produce malformed JSON → "JSON parse failed" toast. Use 4B+ for reliable results
- For vision/image features, use a VLM — the app warns you if the selected model name does not look like a vision model

---

### Using Local LLMs with the GitHub-Hosted Web App

The hosted version at GitHub Pages runs entirely in your browser. To connect it to a local LM Studio or Ollama server, you need to expose your local server to the internet. The easiest way is [**ngrok**](https://ngrok.com/):

1. Start your LLM server normally (LM Studio on port 1234, Ollama on port 11434)
2. Install ngrok (free, works on Windows, macOS, Linux): `npm install -g ngrok` or download from ngrok.com
3. Run: `ngrok http 1234` (or your port)
4. ngrok gives you a public HTTPS URL like `https://abc123.ngrok-free.app`
5. Paste that URL into **Settings → Local LLM → Base URL** in the app

The tunnel is free, fast, and requires no server setup. Your model runs locally; ngrok just forwards the HTTPS traffic from the browser to your machine.

> **Privacy note:** ngrok traffic passes through ngrok's servers as HTTPS. If you prefer fully local operation, run the Electron desktop app instead (see below) — it connects to `localhost` directly with no tunnel needed.

### Running Fully Locally with Electron

The desktop (Electron) build connects directly to `http://localhost:1234` — no tunnel, no CORS, no internet required:

```bash
git clone https://github.com/dzyla/manuscriptAI
cd manuscript-ai-editor
npm install
npm run build:electron
```

This produces a standalone app in `release/`. All LLM traffic stays on your machine. The Electron build also bypasses CORS for the semantic literature search API.

---

### Customizing Agent Prompts

Each agent's system prompt can be replaced entirely in **Settings → Agent Prompts**. This lets you tune the review focus for your field (e.g., make Reviewer 2 focus on clinical trial reporting standards).

---

## Workspace Save & Load

**Save Workspace** (`Ctrl+S` or Download menu) exports a `.json` file with:
- Manuscript content (HTML)
- All suggestions (pending and applied)
- Chat history
- AI settings
- All uploaded sources (text + AI digest + matched metadata)

**Load Workspace** restores everything, including sources, in one step.

---

## Project Structure

```
src/
├── App.tsx                     # Root layout, state, analysis orchestration, citation registry
├── components/
│   ├── Editor.tsx              # TipTap editor, bubble menu, @ citation picker, section navigation
│   ├── Sidebar.tsx             # Chat, suggestions, history, sources, reference manager
│   ├── PostDraftingView.tsx    # Rebuttal & cover letter generator
│   └── SettingsModal.tsx       # Provider config & agent prompt customization
├── services/
│   ├── ai.ts                   # All LLM calls, agent prompts, judge agent, digest functions
│   ├── manuscriptSearch.ts     # manuscript-search.org API client (semantic search)
│   └── citations.ts            # BibTeX parsing, citation cross-check, bibliography formatter
├── types.ts                    # TypeScript interfaces (ManuscriptSource, AISettings, Suggestion…)
└── index.css                   # Design system (CSS variables, light/dark, editor styles)
electron/
└── main.ts                     # Electron main process, IPC handlers, CORS-free net requests
```

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+S` | Save workspace |
| `Ctrl+Shift+A` | Analyze with all agents |
| `Ctrl+?` | Show keyboard shortcuts |
| `Ctrl+B` / `I` / `U` | Bold / Italic / Underline |
| `@` (in editor) | Open citation picker |

---

## Architecture Notes

### CORS in the Browser Build

The semantic search API is called over HTTPS (`manuscript-search.org`). In the Electron desktop build, requests go through the main process `net` module which bypasses CORS entirely. In the browser build, standard `fetch` is used — the server must send appropriate CORS headers.

### Citation Renumbering

`[N]` markers are plain text nodes in the TipTap document. On insert or renumber, the app scans the full editor HTML in document order, collects all `[N]` patterns, builds an ordered mapping (first occurrence = 1, second = 2, …), rewrites the HTML, and updates the citation registry. This is done synchronously with an `isRenumbering` guard to prevent re-entrant updates.

### Source Digest vs. Manuscript Context

The `digestApiSource()` function generates source summaries **without** including your current manuscript in the prompt. This is deliberate — early testing showed that when both the manuscript and a noisy PDF were sent together, the LLM defaulted to summarizing the cleaner manuscript text instead of the reference. The digest is a standalone scholarly summary of the uploaded source only.

---

## License

MIT
