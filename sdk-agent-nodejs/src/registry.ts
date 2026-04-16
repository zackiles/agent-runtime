import * as fs from "fs";
import * as path from "path";

const FUSE_MOUNT = "/registry";

export class AgentRegistry {
  private static _instance: AgentRegistry;
  private controlPlaneUrl: string;
  private token: string;
  private tenantId: string;
  private fuseMounted: boolean;

  constructor(opts: {
    controlPlaneUrl: string;
    token: string;
    tenantId: string;
  }) {
    this.controlPlaneUrl = opts.controlPlaneUrl;
    this.token = opts.token;
    this.tenantId = opts.tenantId;
    this.fuseMounted = fs.existsSync(FUSE_MOUNT) &&
      fs.statSync(FUSE_MOUNT).isDirectory();
  }

  static init(opts: ConstructorParameters<typeof AgentRegistry>[0]): void {
    AgentRegistry._instance = new AgentRegistry(opts);
  }

  static get instance(): AgentRegistry {
    if (!AgentRegistry._instance) {
      throw new Error("AgentRegistry not initialized");
    }
    return AgentRegistry._instance;
  }

  async rules(slug: string, version = "0.0.1"): Promise<string | null> {
    if (this.fuseMounted) {
      return this.readFuse("rules", slug, version, "rule.md");
    }
    return this.readApi("rules", slug, version);
  }

  async skills(slug: string, version = "0.0.1"): Promise<string | null> {
    if (this.fuseMounted) {
      return this.readFuse("skills", slug, version, "skill.md");
    }
    return this.readApi("skills", slug, version);
  }

  async listRules(): Promise<string[]> {
    if (this.fuseMounted) {
      return this.listFuse("rules");
    }
    return this.listApi("rules");
  }

  async listSkills(): Promise<string[]> {
    if (this.fuseMounted) {
      return this.listFuse("skills");
    }
    return this.listApi("skills");
  }

  async listEntityFiles(
    type: "agents" | "tools", slug: string, version = "0.0.1",
  ): Promise<string[]> {
    const prefix = `${this.tenantId}/${type}/${slug}/${version}/files/`;
    const res = await fetch(
      `${this.controlPlaneUrl}/storage/list?prefix=${encodeURIComponent(prefix)}`,
      { headers: { Authorization: `Bearer ${this.token}` } },
    );
    if (!res.ok) return [];
    const paths = (await res.json()) as string[];
    return paths.map((p) => p.slice(prefix.length)).filter(Boolean);
  }

  async downloadEntityFile(
    type: "agents" | "tools",
    slug: string,
    filename: string,
    dest: string,
    version = "0.0.1",
  ): Promise<boolean> {
    const gcsPath =
      `${this.tenantId}/${type}/${slug}/${version}/files/${filename}`;
    const params = new URLSearchParams({
      path: gcsPath, method: "GET", ttl: "600",
    });
    const signRes = await fetch(
      `${this.controlPlaneUrl}/storage/sign?${params}`,
      { headers: { Authorization: `Bearer ${this.token}` } },
    );
    if (!signRes.ok) return false;
    const { url } = (await signRes.json()) as { url: string };
    const dataRes = await fetch(url);
    if (!dataRes.ok) return false;
    const buf = Buffer.from(await dataRes.arrayBuffer());
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    return true;
  }

  async downloadAllEntityFiles(
    type: "agents" | "tools",
    slug: string,
    destDir: string,
    version = "0.0.1",
  ): Promise<string[]> {
    const files = await this.listEntityFiles(type, slug, version);
    const downloaded: string[] = [];
    for (const name of files) {
      const dest = path.join(destDir, name);
      if (await this.downloadEntityFile(type, slug, name, dest, version)) {
        downloaded.push(dest);
      }
    }
    return downloaded;
  }

  private readFuse(
    type: string,
    slug: string,
    version: string,
    filename: string,
  ): string | null {
    const filePath = path.join(
      FUSE_MOUNT,
      this.tenantId,
      type,
      slug,
      version,
      filename,
    );
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  private listFuse(type: string): string[] {
    const dir = path.join(FUSE_MOUNT, this.tenantId, type);
    try {
      return fs.readdirSync(dir).filter((entry) => {
        return fs.statSync(path.join(dir, entry)).isDirectory();
      });
    } catch {
      return [];
    }
  }

  private async readApi(
    type: string,
    slug: string,
    _version: string,
  ): Promise<string | null> {
    if (!this.controlPlaneUrl) return null;
    try {
      const res = await fetch(
        `${this.controlPlaneUrl}/${type}/${slug}`,
        { headers: { Authorization: `Bearer ${this.token}` } },
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { content?: string };
      return data.content ?? null;
    } catch {
      return null;
    }
  }

  private async listApi(type: string): Promise<string[]> {
    if (!this.controlPlaneUrl) return [];
    try {
      const res = await fetch(
        `${this.controlPlaneUrl}/${type}`,
        { headers: { Authorization: `Bearer ${this.token}` } },
      );
      if (!res.ok) return [];
      const data = (await res.json()) as Array<{ slug?: string }>;
      return data.map((d) => d.slug ?? "").filter(Boolean);
    } catch {
      return [];
    }
  }
}
