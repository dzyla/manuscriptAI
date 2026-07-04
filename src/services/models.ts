// Central registry of default model IDs and the picklists shown in Settings.
//
// Keeping these in one place stops the defaults from drifting out of sync
// between the store, the settings UI, and the AI service. Update here when a
// provider ships a new generation.

export const DEFAULT_MODELS = {
  gemini: 'gemini-3.1-pro-preview',
  openai: 'gpt-5.4-mini',
  // Current Anthropic Sonnet-tier model. Adaptive thinking only; the app never
  // sends temperature/thinking to Anthropic, which is required on this family.
  anthropic: 'claude-sonnet-5',
  local: 'local-model',
} as const;

/** Anthropic base URL — OpenAI-compatible providers use the OpenAI SDK path. */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
export const ANTHROPIC_API_VERSION = '2023-06-01';

/** Suggested models per provider, surfaced as datalist hints in Settings. */
export const SUGGESTED_MODELS: Record<string, string[]> = {
  gemini: ['gemini-3.1-pro-preview', 'gemini-3.1-flash-preview', 'gemini-2.5-pro'],
  openai: ['gpt-5.4-mini', 'gpt-5.4', 'gpt-5-mini'],
  anthropic: ['claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5'],
  local: ['local-model'],
};
