// src/common/models.ts
// Single list of selectable LLMs, shared by the workspace dropdown and the
// settings page. Values are LiteLLM model strings understood by engine/main.py
// ("cliproxy/*" routes through the local CLIProxyAPI server).

export interface ModelOption {
  value: string
  label: string
}

export interface ModelGroup {
  label: string
  options: ModelOption[]
}

export const MODEL_GROUPS: ModelGroup[] = [
  {
    label: 'CLIProxyAPI',
    options: [
      { value: 'cliproxy/gemini-3-flash', label: 'Gemini 3 Flash' },
      { value: 'cliproxy/gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite' },
      { value: 'cliproxy/gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
      { value: 'cliproxy/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' }
    ]
  },
  {
    label: 'Direct API key',
    options: [
      { value: 'ollama/llama3.1:8b', label: 'Local (Llama 3.1 8B)' },
      { value: 'gemini/gemini-2.5-flash-lite', label: 'Gemini Flash Lite' },
      { value: 'gpt-4o', label: 'GPT-4o' },
      { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' }
    ]
  }
]

// Picked from engine/evals (Oct 2026): 3.8-flash-high was the only model that
// never skipped a must-ask clarifying question and had the best plans; it is
// ~3x slower to first token (~7s) than gemini-3-flash, the fast alternative.
export const DEFAULT_CHAT_MODEL = 'cliproxy/gemini-3.8-flash-high'
export const DEFAULT_PLAN_MODEL = 'cliproxy/gemini-3.8-flash-high'

/**
 * Persisted app settings (system/settings.json).
 * - chatModel: drives the intake conversation (and everything, unless planModel is set).
 * - planModel: optional stronger model for building/adjusting the checklist itself.
 *   '' means "same as chatModel".
 * - aiNudges: let the LLM personalise nudge notification copy (falls back to templates).
 * - weeklyReview: a kind Sunday summary in History, with a notification.
 */
export interface AppSettings {
  chatModel: string
  planModel: string
  aiNudges: boolean
  weeklyReview: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  chatModel: DEFAULT_CHAT_MODEL,
  planModel: DEFAULT_PLAN_MODEL,
  aiNudges: true,
  weeklyReview: true
}
