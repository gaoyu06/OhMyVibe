import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { SessionDetails } from "../shared/types.js";

interface LegacySessionStoreShape {
  version: 1;
  sessions: SessionDetails[];
}

export class SessionStore {
  private readonly legacyFilePath: string;
  private readonly sessionsDirPath: string;
  private initializationPromise?: Promise<void>;

  constructor(rootDir: string = process.cwd()) {
    this.legacyFilePath = path.join(rootDir, "data", "sessions.json");
    this.sessionsDirPath = path.join(rootDir, "data", "sessions");
  }

  load(): SessionDetails[] {
    const fromDirectory = this.loadFromDirectory();
    if (fromDirectory.length) {
      return fromDirectory;
    }

    return this.loadLegacy();
  }

  async saveSession(session: SessionDetails): Promise<void> {
    await this.ensureInitialized();
    await fsPromises.writeFile(
      path.join(this.sessionsDirPath, this.sessionFileName(session.id)),
      JSON.stringify(session, null, 2),
      "utf8",
    );
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.ensureInitialized();
    await fsPromises.rm(path.join(this.sessionsDirPath, this.sessionFileName(sessionId)), {
      force: true,
    });
  }

  private loadFromDirectory(): SessionDetails[] {
    try {
      if (!fs.existsSync(this.sessionsDirPath)) {
        return [];
      }

      const sessions = fs
        .readdirSync(this.sessionsDirPath, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => {
          const raw = fs.readFileSync(path.join(this.sessionsDirPath, entry.name), "utf8");
          return JSON.parse(raw) as SessionDetails;
        })
        .filter((session) => this.isSessionDetails(session));

      return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
      return [];
    }
  }

  private loadLegacy(): SessionDetails[] {
    try {
      if (!fs.existsSync(this.legacyFilePath)) {
        return [];
      }

      const raw = fs.readFileSync(this.legacyFilePath, "utf8");
      if (!raw.trim()) {
        return [];
      }

      const parsed = JSON.parse(raw) as LegacySessionStoreShape;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
        return [];
      }

      return parsed.sessions.filter((session) => this.isSessionDetails(session));
    } catch {
      return [];
    }
  }

  private sessionFileName(sessionId: string): string {
    return `${sessionId}.json`;
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initializationPromise) {
      const initialization = (async () => {
        await fsPromises.mkdir(this.sessionsDirPath, { recursive: true });
        await fsPromises.rm(this.legacyFilePath, { force: true }).catch(() => undefined);
      })();
      this.initializationPromise = initialization.catch((error) => {
        this.initializationPromise = undefined;
        throw error;
      });
    }

    return this.initializationPromise;
  }

  private isSessionDetails(value: unknown): value is SessionDetails {
    if (!value || typeof value !== "object") {
      return false;
    }
    const candidate = value as Partial<SessionDetails>;
    return (
      typeof candidate.id === "string" &&
      typeof candidate.title === "string" &&
      typeof candidate.cwd === "string" &&
      Array.isArray(candidate.transcript)
    );
  }
}
