import { useState, useRef, useEffect, type Dispatch, type SetStateAction } from 'react';
import { wrap } from 'comlink';
import { Cite } from '@citation-js/core';
import '@citation-js/plugin-bibtex';
import type { AISettings, ManuscriptSource, PdfMatchScore, SemanticSearchResult } from '../../../types';
import type { DocxWorkerApi } from '../../../workers/docxWorker';
import { extractTextFromPDF } from '../../../workers/pdfWorker';
import { searchSimilarManuscripts } from '../../../services/manuscriptSearch';
import { digestApiSource, extractPdfAbstractAea, scorePdfMatches } from '../../../services/ai';
import { useSourceStore } from '../../../stores/useSourceStore';

/** Candidate published records for an uploaded PDF, by source id, waiting for the person to confirm one. */
export type PendingPdfMatches = Record<string, { results: SemanticSearchResult[]; matchIndex: number; scores?: PdfMatchScore[] }>;

/**
 * Everything about getting files into the library: parsing, the digest -> abstract -> database search -> scoring pipeline, and drag state.
 * It lives in CitePanel (which stays mounted when the panel is closed), so an upload in progress keeps going and its result lands.
 */
export function useSourceUpload(aiSettings: AISettings | undefined, setPendingPdfMatches: Dispatch<SetStateAction<PendingPdfMatches>>) {
  const { addSources, updateSource } = useSourceStore();
  // PDF parsing runs on the main thread (pdfjs spawns its own internal worker).
  // DOCX parsing still uses a Comlink worker to keep mammoth off the main thread.
  const docxWorkerRef = useRef<ReturnType<typeof wrap<DocxWorkerApi>> | null>(null);
  useEffect(() => {
    const rawDocx = new Worker(new URL('../../../workers/docxWorker.ts', import.meta.url), { type: 'module' });
    docxWorkerRef.current = wrap<DocxWorkerApi>(rawDocx);
    return () => { rawDocx.terminate(); };
  }, []);
  const [isDragging, setIsDragging] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [parsingFileName, setParsingFileName] = useState<string | null>(null);
  const [digestingId, setDigestingId] = useState<string | null>(null);
  const fileUploadRef = useRef<HTMLInputElement>(null);

  const processFiles = async (files: File[]) => {
    const supported = ['.pdf', '.bib', '.txt', '.md', '.docx'];
    const filtered = files.filter(f => supported.some(ext => f.name.toLowerCase().endsWith(ext)));
    if (filtered.length === 0) return;

    setIsParsing(true);
    const newSources: ManuscriptSource[] = [];

    for (const file of filtered) {
      setParsingFileName(file.name);
      const nameLower = file.name.toLowerCase();
      try {
        if (nameLower.endsWith('.pdf')) {
          const text = await extractTextFromPDF(file);
          if (!text || text.trim().length === 0) {
            throw new Error(`No text found in "${file.name}" — is it a scanned image-only PDF?`);
          }
          const id = Date.now().toString() + Math.random();
          newSources.push({ id, name: file.name, type: 'pdf' as const, text, queryText: undefined });
        } else if (nameLower.endsWith('.bib')) {
          const text = await file.text();
          new Cite(text);
          newSources.push({ id: Date.now().toString() + Math.random(), name: file.name, type: 'bib' as const, text });
        } else if (nameLower.endsWith('.docx')) {
          let text: string;
          if (docxWorkerRef.current) {
            text = await docxWorkerRef.current.extractText(await file.arrayBuffer());
          } else {
            // Fallback if worker not ready
            const mammoth = await import('mammoth');
            const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
            text = result.value;
          }
          newSources.push({ id: Date.now().toString() + Math.random(), name: file.name, type: 'text' as const, text });
        } else if (nameLower.endsWith('.txt') || nameLower.endsWith('.md')) {
          const text = await file.text();
          newSources.push({ id: Date.now().toString() + Math.random(), name: file.name, type: 'text' as const, text });
        }
      } catch (err) {
        console.error('Failed to parse file:', file.name, err);
      }
    }
    setParsingFileName(null);

    if (newSources.length > 0) {
      addSources(newSources);
      // Full pipeline for PDFs and text documents:
      // digest → Abstract Extraction Agent → DB search → scoring agent
      if (aiSettings) {
        for (const src of newSources) {
          if (src.type === 'pdf' || src.type === 'text') {
            const srcId = src.id;

            // Step 1 — Digest
            setDigestingId(srcId);
            setParsingFileName(`Digesting ${src.name}...`);
            let digest = '';
            try {
              digest = await digestApiSource(src.text, src.name, aiSettings);
              updateSource(srcId, { digest });
            } catch (_) {}
            setDigestingId(null);

            // Step 2 — Abstract Extraction Agent (AEA)
            setParsingFileName(`Extracting abstract for ${src.name}...`);
            let abstractText = '';
            try {
              abstractText = await extractPdfAbstractAea(src.text, src.name, aiSettings);
              updateSource(srcId, { abstractText });
            } catch (_) {}

            // Step 3 — Database search (prefer abstract over digest for query)
            setParsingFileName(`Searching database for ${src.name}...`);
            const searchQuery = (abstractText && abstractText.length > 50 && !abstractText.startsWith('Abstract not available'))
              ? abstractText.slice(0, 700)
              : digest.replace(/\*\*[^*]+\*\*:?/g, '').replace(/\s+/g, ' ').trim().slice(0, 700);

            if (searchQuery.length >= 3) {
              try {
                const results = await searchSimilarManuscripts(searchQuery, 10);
                if (results.length > 0) {
                  const top10 = results.slice(0, 10);
                  // Set results immediately so the UI shows while scoring runs
                  setPendingPdfMatches(prev => ({ ...prev, [srcId]: { results: top10, matchIndex: 0 } }));

                  // Step 4 — Scoring agent (async, updates UI when done)
                  const queryForScoring = (abstractText && !abstractText.startsWith('Abstract not available'))
                    ? abstractText
                    : digest;
                  scorePdfMatches(src.name, queryForScoring, top10, aiSettings)
                    .then(scores => {
                      if (scores.length > 0) {
                        // Re-order results by score, update matchIndex to 0
                        const ordered = scores.map(s => top10[s.index]).filter(Boolean);
                        setPendingPdfMatches(prev => {
                          const existing = prev[srcId];
                          if (!existing) return prev;
                          return { ...prev, [srcId]: { results: ordered, matchIndex: 0, scores } };
                        });
                      }
                    })
                    .catch(() => {});
                }
              } catch (_) {}
            }

            setParsingFileName(null);
          }
        }
      }
    }
    setIsParsing(false);
  };

  const handleFileDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    await processFiles(Array.from(e.dataTransfer.files));
  };

  const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    await processFiles(files);
    if (fileUploadRef.current) fileUploadRef.current.value = '';
  };

  return { isDragging, setIsDragging, isParsing, parsingFileName, digestingId, fileUploadRef, processFiles, handleFileDrop, handleFileInput };
}

export type SourceUpload = ReturnType<typeof useSourceUpload>;
