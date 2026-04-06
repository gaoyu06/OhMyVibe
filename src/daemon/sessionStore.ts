import fs from "node:fs";
import path from "node:path";
import { SessionDetails } from "../shared/types.js";

interface SessionStoreShape {
  version: 1;
  sessions: SessionDetails[];
}

export class SessionStore {
  private readonly filePath: string;

  constructor(rootDir: string = process.cwd()) {
    this.filePath = path.join(rootDir, "data", "sessions.json");
  }

  load(): SessionDetails[] {
    try {
      if (!fs.existsSync(this.filePath)) {
        return [];
      }

      const raw = fs.readFileSync(this.filePath, "utf8");
      if (!raw.trim()) {
        return [];
      }

      const parsed = JSON.parse(raw) as SessionStoreShape;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
        return [];
      }

      return parsed.sessions;
    } catch {
      return [];
    }
  }

  save(sessions: SessionDetails[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: SessionStoreShape = {
      version: 1,
      sessions,
    };
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), "utf8");
  }
}
