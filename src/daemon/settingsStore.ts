import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { GlobalSettings } from "../shared/types.js";

const DEFAULT_SETTINGS: GlobalSettings = {
  provider: {
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-5.3-codex",
    temperature: 0.2,
    maxOutputTokens: 4000,
  },
  notifications: {
    smtpHost: "",
    smtpPort: 587,
    smtpUser: "",
    smtpPass: "",
    smtpFrom: "",
    smtpSecure: false,
  },
};

export class SettingsStore {
  private readonly filePath: string;
  private initializationPromise?: Promise<void>;

  constructor(rootDir: string = process.cwd()) {
    this.filePath = path.join(rootDir, "data", "settings.json");
  }

  load(): GlobalSettings {
    try {
      if (!fs.existsSync(this.filePath)) {
        return structuredClone(DEFAULT_SETTINGS);
      }

      const raw = fs.readFileSync(this.filePath, "utf8");
      if (!raw.trim()) {
        return structuredClone(DEFAULT_SETTINGS);
      }

      const parsed = JSON.parse(raw) as Partial<GlobalSettings>;
      return {
        provider: {
          ...DEFAULT_SETTINGS.provider,
          ...(parsed.provider ?? {}),
          provider: "openai",
        },
        notifications: {
          ...DEFAULT_SETTINGS.notifications,
          ...(parsed.notifications ?? {}),
        },
      };
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  async save(settings: GlobalSettings): Promise<void> {
    await this.ensureInitialized();
    await fsPromises.writeFile(this.filePath, JSON.stringify(settings, null, 2), "utf8");
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
