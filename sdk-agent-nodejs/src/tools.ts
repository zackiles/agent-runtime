import { execFileSync, execSync } from "child_process";
import { readdirSync } from "fs";
import { join } from "path";
import { AgentSecrets } from "./secrets.js";

type McpTransport = "stdio" | "http";

type McpConfig = {
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
};

type ToolConfig = {
  name: string;
  slug: string;
  version: string;
  description?: string;
  type?: "stdio" | "mcp";
  mcp?: McpConfig;
  flags: string[];
  env: Record<string, string>;
};

const PASSTHROUGH_VARS = [
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "NODE_ENV",
];

let nextMcpId = 1;

class McpClient {
  private proc: ReturnType<typeof import("child_process").spawn> | null = null;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buffer = "";
  private config: McpConfig;
  private env: Record<string, string>;

  constructor(config: McpConfig, env: Record<string, string>) {
    this.config = config;
    this.env = env;
  }

  private async ensureStdio(): Promise<void> {
    if (this.proc) return;
    const { spawn } = await import("child_process");
    this.proc = spawn(this.config.command!, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.env } as Record<string, string>,
    });
    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.drain();
    });
    this.proc.on("error", (err: Error) => {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
    this.proc.on("close", () => {
      this.proc = null;
    });
    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "ar-agent", version: "1.0.0" },
    });
    this.sendNotification("notifications/initialized", {});
  }

  private drain(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            p.reject(new Error(msg.error.message ?? "MCP error"));
          } else {
            p.resolve(msg.result);
          }
        }
      } catch {
        // skip malformed lines
      }
    }
  }

  private async send(method: string, params: unknown): Promise<unknown> {
    if (this.config.transport === "http") {
      return this.sendHttp(method, params);
    }
    await this.ensureStdio();
    const id = nextMcpId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.proc!.stdin!.write(msg + "\n");
    });
  }

  private sendNotification(method: string, params: unknown): void {
    if (this.config.transport === "http") return;
    if (!this.proc) return;
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.proc.stdin!.write(msg + "\n");
  }

  private async sendHttp(
    method: string,
    params: unknown,
  ): Promise<unknown> {
    const id = nextMcpId++;
    const url = this.config.url!;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.config.headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const body = await res.json();
    if (body.error) {
      throw new Error(body.error.message ?? "MCP error");
    }
    return body.result;
  }

  async listTools(): Promise<
    Array<{ name: string; description?: string; inputSchema?: unknown }>
  > {
    const result = (await this.send("tools/list", {})) as {
      tools: Array<{
        name: string;
        description?: string;
        inputSchema?: unknown;
      }>;
    };
    return result.tools ?? [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const result = (await this.send("tools/call", {
      name,
      arguments: args,
    })) as { content?: Array<{ text?: string; type?: string }> };
    if (!result.content?.length) return "";
    return result.content
      .map((c) => c.text ?? "")
      .filter(Boolean)
      .join("\n");
  }

  close(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }
}

function findExecutable(dir: string, prefix: string): string | null {
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const lower = entry.toLowerCase();
      if (
        lower === prefix ||
        (lower.startsWith(`${prefix}.`) && lower !== `${prefix}.json`)
      ) {
        return join(dir, entry);
      }
    }
  } catch {
    // directory doesn't exist
  }
  return null;
}

export class AgentTools {
  private static _instance: AgentTools;
  private toolsDir: string;
  private configs: Map<string, ToolConfig>;
  private mcpClients: Map<string, McpClient> = new Map();

  constructor(toolsDir = "/bin/tools", configs?: ToolConfig[]) {
    this.toolsDir = toolsDir;
    this.configs = new Map();
    if (configs) {
      for (const c of configs) this.configs.set(c.slug, c);
    }
  }

  static init(toolsDir?: string, configs?: ToolConfig[]): void {
    AgentTools._instance = new AgentTools(toolsDir, configs);
  }

  static get instance(): AgentTools {
    if (!AgentTools._instance) throw new Error("AgentTools not initialized");
    return AgentTools._instance;
  }

  config(name: string): ToolConfig | null {
    return this.configs.get(name) ?? null;
  }

  isMcp(name: string): boolean {
    const tc = this.configs.get(name);
    return tc?.type === "mcp" && !!tc.mcp;
  }

  private getMcpClient(name: string): McpClient {
    if (this.mcpClients.has(name)) return this.mcpClients.get(name)!;
    const tc = this.configs.get(name);
    if (!tc?.mcp) throw new Error(`No MCP config for tool '${name}'`);
    const env = this.resolveEnv(name);
    const client = new McpClient(tc.mcp, env);
    this.mcpClients.set(name, client);
    return client;
  }

  async mcpList(
    name: string,
  ): Promise<
    Array<{ name: string; description?: string; inputSchema?: unknown }>
  > {
    return this.getMcpClient(name).listTools();
  }

  async mcpCall(
    name: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    return this.getMcpClient(name).callTool(toolName, args);
  }

  closeMcp(): void {
    for (const client of this.mcpClients.values()) client.close();
    this.mcpClients.clear();
  }

  private resolveBinary(name: string): string {
    const containerDir = join("/app/tools", name);
    const containerPath = findExecutable(containerDir, "tool");
    if (containerPath) return containerPath;

    const toolDir = join(this.toolsDir, name);
    const path = findExecutable(toolDir, "tool");
    if (path) return path;

    const installPath = findExecutable(toolDir, "install");
    if (installPath) {
      execSync(installPath, {
        cwd: toolDir,
        encoding: "utf-8",
        env: {
          ...process.env as Record<string, string>,
          TOOLS_DIR: toolDir,
        },
      });
      const retryPath = findExecutable(toolDir, "tool");
      if (retryPath) return retryPath;
    }

    return name;
  }

  run(
    name: string,
    input: string,
    opts?: { timeout?: number; cwd?: string },
  ): string {
    const timeout = opts?.timeout ?? 120_000;
    const binary = this.resolveBinary(name);
    const tc = this.configs.get(name);
    const flags = tc?.flags ?? [];
    const shared = {
      timeout,
      encoding: "utf-8" as const,
      env: this.resolveEnv(name),
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    };
    if (flags.length > 0) {
      return (execFileSync(binary, [...flags, input], {
        ...shared,
        maxBuffer: 50 * 1024 * 1024,
      }) as string).trim();
    }
    return execSync(binary, { ...shared, input }).trim();
  }

  async exec(
    name: string,
    args: string[],
    input?: string,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    const { spawn } = await import("child_process");
    const binary = this.resolveBinary(name);
    return new Promise((resolve, reject) => {
      const proc = spawn(binary, args, {
        env: this.resolveEnv(name),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      if (input) {
        proc.stdin.write(input);
      }
      proc.stdin.end();
      proc.on(
        "close",
        (code: number) =>
          resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code }),
      );
      proc.on("error", reject);
    });
  }

  async credentials(
    ...names: string[]
  ): Promise<Record<string, string | null>> {
    const secrets = AgentSecrets.instance;
    const result: Record<string, string | null> = {};
    for (const name of names) {
      result[name] = await secrets.get(name);
    }
    return result;
  }

  async warmSecrets(name: string): Promise<void> {
    const tc = this.configs.get(name);
    if (!tc?.env) return;
    let secrets: typeof AgentSecrets.instance | null = null;
    try {
      secrets = AgentSecrets.instance;
    } catch {
      return;
    }
    for (const template of Object.values(tc.env)) {
      const match = template.match(/^\$\{(\w+)\}$/);
      if (!match) continue;
      const envKey = match[1];
      if (process.env[envKey]) continue;
      const secretName = envKey.toLowerCase().replace(/_/g, "-");
      const value = await secrets.get(secretName);
      if (value) process.env[envKey] = value;
    }
  }

  private resolveEnv(name: string): Record<string, string> {
    const tc = this.configs.get(name);
    const toolDir = join(this.toolsDir, name);

    if (!tc?.env || Object.keys(tc.env).length === 0) {
      return {
        ...(process.env as Record<string, string>),
        PATH: `${toolDir}:${this.toolsDir}:${process.env.PATH ?? ""}`,
      };
    }

    const env: Record<string, string> = {
      PATH: `${toolDir}:${this.toolsDir}:${process.env.PATH ?? ""}`,
    };

    for (const key of PASSTHROUGH_VARS) {
      if (process.env[key]) env[key] = process.env[key]!;
    }

    for (const [key, template] of Object.entries(tc.env)) {
      const value = template.replace(
        /\$\{(\w+)\}/g,
        (_, v: string) => process.env[v] ?? "",
      );
      if (value) env[key] = value;
    }

    return env;
  }
}

export type { ToolConfig };
