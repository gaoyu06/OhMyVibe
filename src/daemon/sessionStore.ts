import fs from "node:fs";
import path from "node:path";
import { SessionDetails } from "../shared/types.js";

interface LegacySessionStoreShape {
  version: 1;
  sessions: SessionDetails[];
}

export class SessionStore {
  private readonly legacyFilePath: string;
  private readonly sessionsDirPath: string;

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

  save(sessions: SessionDetails[]): void {
    fs.mkdirSync(this.sessionsDirPath, { recursive: true });

    const expectedFileNames = new Set<string>();
    for (const session of sessions) {
      const fileName = this.sessionFileName(session.id);
      expectedFileNames.add(fileName);
      fs.writeFileSync(
        path.join(this.sessionsDirPath, fileName),
        JSON.stringify(session, null, 2),
        "utf8",
      );
    }

    try {
      for (const entry of fs.readdirSync(this.sessionsDirPath, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }
        if (!expectedFileNames.has(entry.name)) {
          fs.rmSync(path.join(this.sessionsDirPath, entry.name), { force: true });
        }
      }
    } catch {
      // noop
    }

    if (fs.existsSync(this.legacyFilePath)) {
      fs.rmSync(this.legacyFilePath, { force: true });
    }
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
