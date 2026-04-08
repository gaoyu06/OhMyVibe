import { EventEmitter } from "node:events";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";

export interface JsonRpcNotification {
  method: string;
  params?: any;
}

export interface JsonRpcRequest {
  id: string | number;
  method: string;
  params?: any;
}

export class JsonRpcProcess extends EventEmitter<{
  notification: [JsonRpcNotification];
  request: [JsonRpcRequest];
  stderr: [string];
  exit: [{ code: number | null; signal: NodeJS.Signals | null }];
}> {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
    }
  >();
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private finished = false;

  constructor(command: string, args: string[], cwd: string) {
    super();
    this.child = spawn(command, args, {
      cwd,
      stdio: "pipe",
      env: process.env,
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => this.onStderr(chunk));
    this.child.stdin.on("error", (error) => this.handleFailure(error));
    this.child.stdout.on("error", (error) => this.handleFailure(error));
    this.child.stderr.on("error", (error) => this.handleFailure(error));
    this.child.on("error", (error) => {
      this.handleFailure(error, { code: null, signal: null });
    });
    this.child.on("exit", (code, signal) => {
      if (this.finished) {
        return;
      }
      this.finished = true;
      this.flushStderr();
      const error = new Error(`JSON-RPC process exited (code=${code}, signal=${signal})`);
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
      this.emit("exit", { code, signal });
    });
  }

  async request<TResponse>(method: string, params?: unknown): Promise<TResponse> {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };

    return new Promise<TResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  notify(method: string, params?: unknown): void {
    const payload = { jsonrpc: "2.0", method, params };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
  }

  respond(id: string | number, result: unknown): void {
    const payload = { jsonrpc: "2.0", id, result };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
  }

  respondError(id: string | number, code: number, message: string): void {
    const payload = {
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
      },
    };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
  }

  async close(): Promise<void> {
    this.child.kill();
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;

    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      const message = JSON.parse(line);
      if (typeof message.id !== "undefined") {
        const pending = this.pending.get(Number(message.id));
        if (!pending && message.method) {
          this.emit("request", {
            id: message.id,
            method: message.method,
            params: message.params,
          });
          continue;
        }
        if (!pending) {
          continue;
        }
        this.pending.delete(Number(message.id));

        if (message.error) {
          pending.reject(
            new Error(
              typeof message.error?.message === "string"
                ? message.error.message
                : "Unknown JSON-RPC error",
            ),
          );
        } else {
          pending.resolve(message.result);
        }
        continue;
      }

      if (message.method) {
        this.emit("notification", { method: message.method, params: message.params });
      }
    }
  }

  private onStderr(chunk: string): void {
    this.stderrBuffer += chunk;

    while (true) {
      const newlineIndex = this.stderrBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const line = this.stderrBuffer.slice(0, newlineIndex);
      this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1);
      if (line.trim()) {
        this.emit("stderr", line);
      }
    }
  }

  private flushStderr(): void {
    const remaining = this.stderrBuffer.trim();
    this.stderrBuffer = "";
    if (remaining) {
      this.emit("stderr", remaining);
    }
  }

  private handleFailure(
    error: Error,
    exit: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null },
  ): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    this.flushStderr();
    this.emit("stderr", error.message);
    this.emit("exit", exit);
  }
}
