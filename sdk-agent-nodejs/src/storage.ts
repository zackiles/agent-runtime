import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";

export class AgentStorage {
  private static _instance: AgentStorage;
  private controlPlaneUrl: string;
  private token: string;
  private bucket: string;
  private tenantId: string;
  private agentId: string;

  constructor(opts: {
    controlPlaneUrl: string;
    token: string;
    bucket: string;
    tenantId: string;
    agentId: string;
  }) {
    this.controlPlaneUrl = opts.controlPlaneUrl;
    this.token = opts.token;
    this.bucket = opts.bucket;
    this.tenantId = opts.tenantId;
    this.agentId = opts.agentId;
  }

  static init(opts: ConstructorParameters<typeof AgentStorage>[0]): void {
    AgentStorage._instance = new AgentStorage(opts);
  }

  static get instance(): AgentStorage {
    if (!AgentStorage._instance) {
      throw new Error("AgentStorage not initialized");
    }
    return AgentStorage._instance;
  }

  private prefix(): string {
    return `${this.tenantId}/agent/${this.agentId}/files`;
  }

  private headers(): Record<string, string> {
    return {
      "Authorization": `Bearer ${this.token}`,
      "X-Tenant": this.tenantId,
    };
  }

  private async sign(
    gcsPath: string,
    method: "GET" | "PUT",
    contentType?: string,
  ): Promise<string> {
    const params = new URLSearchParams({
      path: gcsPath,
      method,
      ttl: "300",
    });
    if (contentType) params.set("contentType", contentType);
    const res = await fetch(
      `${this.controlPlaneUrl}/storage/sign?${params}`,
      { headers: this.headers() },
    );
    if (!res.ok) {
      throw new Error(`Failed to get signed URL: ${res.status}`);
    }
    const json = (await res.json()) as { url: string };
    return json.url;
  }

  async write(filePath: string, data: string): Promise<void> {
    const fullPath = `${this.prefix()}/${filePath}`;
    const url = await this.sign(
      fullPath, "PUT", "application/octet-stream",
    );
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: data,
    });
    if (!res.ok) {
      throw new Error(`Failed to write ${filePath}: ${res.status}`);
    }
  }

  async read(filePath: string): Promise<string> {
    const fullPath = `${this.prefix()}/${filePath}`;
    const url = await this.sign(fullPath, "GET");
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to read ${filePath}: ${res.status}`);
    }
    return await res.text();
  }

  async list(prefix = ""): Promise<string[]> {
    const fullPrefix = `${this.prefix()}/${prefix}`;
    const res = await fetch(
      `${this.controlPlaneUrl}/storage/list?bucket=${this.bucket}&prefix=${
        encodeURIComponent(fullPrefix)
      }`,
      { headers: this.headers() },
    );
    if (!res.ok) return [];
    return (await res.json()) as string[];
  }

  async exists(filePath: string): Promise<boolean> {
    const fullPath = `${this.prefix()}/${filePath}`;
    const res = await fetch(
      `${this.controlPlaneUrl}/storage/exists?bucket=${this.bucket}&path=${
        encodeURIComponent(fullPath)
      }`,
      { headers: this.headers() },
    );
    return res.ok;
  }

  async remove(filePath: string): Promise<void> {
    const fullPath = `${this.prefix()}/${filePath}`;
    await fetch(
      `${this.controlPlaneUrl}/storage?bucket=${this.bucket}&path=${
        encodeURIComponent(fullPath)
      }`,
      {
        method: "DELETE",
        headers: this.headers(),
      },
    );
  }

  async pull(remotePath: string, localDir: string): Promise<void> {
    const files = await this.list(remotePath);
    fs.mkdirSync(localDir, { recursive: true });
    for (const file of files) {
      const relative = file.slice(
        file.indexOf(remotePath) + remotePath.length + 1,
      );
      if (!relative) continue;
      const dest = path.join(localDir, relative);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const data = await this.read(`${remotePath}/${relative}`);
      fs.writeFileSync(dest, data);
    }
  }

  async push(localDir: string, remotePath: string): Promise<void> {
    const entries = this.walkDir(localDir);
    for (const filePath of entries) {
      const relative = path.relative(localDir, filePath);
      const data = fs.readFileSync(filePath, "utf-8");
      await this.write(`${remotePath}/${relative}`, data);
    }
  }

  async listRaw(prefix: string): Promise<string[]> {
    const res = await fetch(
      `${this.controlPlaneUrl}/storage/list?bucket=${this.bucket}&prefix=${
        encodeURIComponent(prefix)
      }`,
      { headers: this.headers() },
    );
    if (!res.ok) return [];
    return (await res.json()) as string[];
  }

  async readRaw(rawPath: string): Promise<Buffer> {
    const url = await this.sign(rawPath, "GET");
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to read ${rawPath}: ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async pullRaw(remotePath: string, localDir: string): Promise<void> {
    const files = await this.listRaw(remotePath);
    fs.mkdirSync(localDir, { recursive: true });
    for (const file of files) {
      const relative = file.slice(
        file.indexOf(remotePath) + remotePath.length + 1,
      );
      if (!relative) continue;
      const dest = path.join(localDir, relative);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const data = await this.readRaw(file);
      fs.writeFileSync(dest, data);
    }
  }

  async writeRaw(
    rawPath: string,
    data: string | Buffer | Uint8Array,
  ): Promise<void> {
    const url = await this.sign(
      rawPath, "PUT", "application/octet-stream",
    );
    const body = typeof data === "string" ? data : new Uint8Array(data);
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body,
    });
    if (!res.ok) {
      throw new Error(`Failed to write ${rawPath}: ${res.status}`);
    }
  }

  async pushRaw(localDir: string, remotePath: string): Promise<void> {
    const entries = this.walkDir(localDir);
    for (const filePath of entries) {
      const relative = path.relative(localDir, filePath);
      const data = fs.readFileSync(filePath);
      await this.writeRaw(`${remotePath}/${relative}`, data);
    }
  }

  async pushArchive(localDir: string, remotePath: string): Promise<void> {
    const tmp = path.join(os.tmpdir(), `ar-${Date.now()}.tar.gz`);
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn("tar", [
          "-czf", tmp,
          "--exclude", "node_modules",
          "--exclude", ".git",
          "--exclude", ".env",
          "-C", localDir, ".",
        ]);
        proc.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))
        );
        proc.on("error", reject);
      });

      const url = await this.sign(remotePath, "PUT", "application/gzip");
      const data = fs.readFileSync(tmp);
      const res = await fetch(url, {
        method: "PUT",
        headers: {
          "Content-Type": "application/gzip",
          "Content-Length": String(data.byteLength),
        },
        body: new Uint8Array(data),
      });
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  async pullArchive(remotePath: string, localDir: string): Promise<void> {
    const { pipeline } = await import("stream/promises");
    const { Readable } = await import("stream");
    const url = await this.sign(remotePath, "GET");
    fs.mkdirSync(localDir, { recursive: true });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const proc = spawn("tar", ["-xzf", "-", "-C", localDir], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    await pipeline(Readable.fromWeb(res.body as any), proc.stdin);
    await new Promise<void>((resolve, reject) => {
      proc.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))
      );
      proc.on("error", reject);
    });
  }

  private static SKIP = new Set([
    "node_modules", ".git", ".env", ".cache", ".next",
  ]);

  private walkDir(dir: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (AgentStorage.SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.walkDir(full));
      } else {
        results.push(full);
      }
    }
    return results;
  }
}
