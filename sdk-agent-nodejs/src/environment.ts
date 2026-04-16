export class AgentEnvironment {
  private static _instance: AgentEnvironment;
  readonly tenant: string;
  readonly agentName: string;
  readonly agentVersion: string;
  readonly agentSlug: string;
  readonly department: string;
  readonly team: string;
  readonly owners: string[];
  readonly publishedAt: string;
  readonly updatedAt: string;
  readonly subsystem: string | null;
  readonly visibility: string;
  readonly registryType: "public" | "private";

  constructor(opts: {
    tenant: string;
    agentName: string;
    agentVersion: string;
    agentSlug: string;
    department: string;
    team: string;
    owners: string[];
    publishedAt: string;
    updatedAt: string;
    subsystem?: string | null;
    visibility?: string;
    registryType?: "public" | "private";
  }) {
    this.tenant = opts.tenant;
    this.agentName = opts.agentName;
    this.agentVersion = opts.agentVersion;
    this.agentSlug = opts.agentSlug;
    this.department = opts.department;
    this.team = opts.team;
    this.owners = opts.owners;
    this.publishedAt = opts.publishedAt;
    this.updatedAt = opts.updatedAt;
    this.subsystem = opts.subsystem ?? null;
    this.visibility = opts.visibility ?? "private";
    this.registryType = opts.registryType ?? "private";
  }

  static init(opts: ConstructorParameters<typeof AgentEnvironment>[0]): void {
    AgentEnvironment._instance = new AgentEnvironment(opts);
  }

  static get instance(): AgentEnvironment {
    if (!AgentEnvironment._instance) {
      throw new Error("AgentEnvironment not initialized");
    }
    return AgentEnvironment._instance;
  }

  get isPublicRegistry(): boolean {
    return this.registryType === "public";
  }

  get isPrivateRegistry(): boolean {
    return this.registryType === "private";
  }

  get isDevelopment(): boolean {
    return this.tenant === "development";
  }

  get isProduction(): boolean {
    return this.tenant === "production";
  }
}
