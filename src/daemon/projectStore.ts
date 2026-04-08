import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import {
  AgentDetails,
  ProjectNotification,
  ProjectSummary,
} from "../shared/types.js";

export interface ProjectStoreState {
  version: 1;
  projects: ProjectSummary[];
  agents: AgentDetails[];
  notifications: ProjectNotification[];
  sessionProjectIds: Record<string, string>;
}

const EMPTY_STATE: ProjectStoreState = {
  version: 1,
  projects: [],
  agents: [],
  notifications: [],
  sessionProjectIds: {},
};

export class ProjectStore {
  private readonly filePath: string;
  private initializationPromise?: Promise<void>;

  constructor(rootDir: string = process.cwd()) {
    this.filePath = path.join(rootDir, "data", "projects", "state.json");
  }

  load(): ProjectStoreState {
    try {
      if (!fs.existsSync(this.filePath)) {
        return structuredClone(EMPTY_STATE);
      }

      const raw = fs.readFileSync(this.filePath, "utf8");
      if (!raw.trim()) {
        return structuredClone(EMPTY_STATE);
      }

      const parsed = JSON.parse(raw) as Partial<ProjectStoreState>;
      if (parsed.version !== 1) {
        return structuredClone(EMPTY_STATE);
      }

      return {
        version: 1,
        projects: Array.isArray(parsed.projects) ? parsed.projects : [],
        agents: Array.isArray(parsed.agents) ? parsed.agents : [],
        notifications: Array.isArray(parsed.notifications) ? parsed.notifications : [],
        sessionProjectIds:
          parsed.sessionProjectIds && typeof parsed.sessionProjectIds === "object"
            ? parsed.sessionProjectIds
            : {},
      };
    } catch {
      return structuredClone(EMPTY_STATE);
    }
  }

  async save(state: ProjectStoreState): Promise<void> {
    await this.ensureInitialized();
    await fsPromises.writeFile(this.filePath, JSON.stringify(state, null, 2), "utf8");
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initializationPromise) {
      const initialization = fsPromises
        .mkdir(path.dirname(this.filePath), { recursive: true })
        .then(() => undefined);
      this.initializationPromise = initialization.catch((error) => {
        this.initializationPromise = undefined;
        throw error;
      });
    }

    return this.initializationPromise;
  }
}
