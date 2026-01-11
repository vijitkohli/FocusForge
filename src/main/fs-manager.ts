import { app } from 'electron';
import path from 'path';
import fs from 'fs-extra';

// Define file hierarchy
const ROOT_DIR = path.join(app.getPath('documents'), 'FlowState');
const SYSTEM_DIR = path.join(ROOT_DIR, 'system');
const REGISTRY_PATH = path.join(SYSTEM_DIR, 'master_index.json');

// Interface what the global registry looks like
interface ProjectSummary {
    id: string;
    name: string;
    path: string;
    progress: number;
    lastActive: string; 
}

export class FileSystemManager{
    constructor() {
        this.ensureSystemPaths();
    }

    /** 
     * Build the root folders
     * Synchronous so we make sure the app does not try to load
     * a folder that does not exist
    */
    private ensureSystemPaths() {
        if (!fs.existsSync(ROOT_DIR)) fs.mkdirSync(ROOT_DIR);
        if (!fs.existsSync(SYSTEM_DIR)) fs.mkdirSync(SYSTEM_DIR);

        if (!fs.existsSync(REGISTRY_PATH)) fs.writeJSONSync(REGISTRY_PATH, []);
    }

    // Create project buckets
    createProject(projectName: string): ProjectSummary {

        // Replace anything that's not a letter or number with underscore
        const safeName = projectName.replace(/[^a-z0-9]/gi, '_');
        const projectPath = path.join(ROOT_DIR, safeName);

        // Build the directories
        fs.ensureDirSync(path.join(projectPath, 'sources'));
        fs.ensureDirSync(path.join(projectPath, '.db'));

        // Create the project data file (local DB)
        const initialData = {
            name: projectName,
            created: new Date().toISOString,
            tasks: []
        };
        fs.writeJSONSync(path.join(projectPath, 'project_data.json'), initialData);

        // Add to the global registry (for quick load)
        const newSummary: ProjectSummary = {
            id: safeName,
            name: projectName,
            path: projectPath,
            progress: 0,
            lastActive: new Date().toISOString()
        };

        // Read the main registry (master_index.json)
        const registry = fs.readJSONSync(REGISTRY_PATH);

        // Push newly made project data (summarised) to main registry
        registry.push(newSummary);
        fs.writeJSONSync(REGISTRY_PATH, registry);

        return newSummary;
    }

    getProjects(): ProjectSummary[] {
        try{
            return fs.readJSONSync(REGISTRY_PATH);
        } catch (e) {
            return[];
        }
    }
}
