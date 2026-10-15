import { app } from 'electron';
import path from 'path';
import fs from 'fs-extra';
import { AppSettings, DEFAULT_SETTINGS } from '../common/models';

// Lives next to the project registry so "reset all data" wipes it too.
const SETTINGS_PATH = path.join(app.getPath('documents'), 'FlowState', 'system', 'settings.json');

/** Reads settings, filling any missing/invalid field from DEFAULT_SETTINGS. */
export async function loadSettings(): Promise<AppSettings> {
    try {
        if (!(await fs.pathExists(SETTINGS_PATH))) return { ...DEFAULT_SETTINGS };
        const raw = await fs.readJSON(SETTINGS_PATH);
        return {
            chatModel: typeof raw.chatModel === 'string' && raw.chatModel ? raw.chatModel : DEFAULT_SETTINGS.chatModel,
            planModel: typeof raw.planModel === 'string' ? raw.planModel : DEFAULT_SETTINGS.planModel,
            aiNudges: typeof raw.aiNudges === 'boolean' ? raw.aiNudges : DEFAULT_SETTINGS.aiNudges
        };
    } catch (error) {
        console.error('Failed to read settings, using defaults', error);
        return { ...DEFAULT_SETTINGS };
    }
}

/** Merges a partial update into the stored settings and returns the result. */
export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const next = { ...(await loadSettings()), ...patch };
    await fs.outputJSON(SETTINGS_PATH, next, { spaces: 2 });
    return next;
}
