export class AgentAudit {
  private static _instance: AgentAudit;
  private controlPlaneUrl: string;
  private token: string;
  private agentId: string;
  private tenantId: string;

  constructor(opts: {
    controlPlaneUrl: string;
    token: string;
    agentId: string;
    tenantId: string;
  }) {
    this.controlPlaneUrl = opts.controlPlaneUrl;
    this.token = opts.token;
    this.agentId = opts.agentId;
    this.tenantId = opts.tenantId;
  }

  static init(opts: ConstructorParameters<typeof AgentAudit>[0]): void {
    AgentAudit._instance = new AgentAudit(opts);
  }

  static get instance(): AgentAudit {
    if (!AgentAudit._instance) {
      throw new Error("AgentAudit not initialized");
    }
    return AgentAudit._instance;
  }

  async log(
    action: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await fetch(`${this.controlPlaneUrl}/audit`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.token}`,
          "Content-Type": "application/json",
          "X-Tenant": this.tenantId,
        },
        body: JSON.stringify({
          entityType: "agent",
          entityId: this.agentId,
          action,
          metadata,
        }),
      });
    } catch {
      console.error(`[ar-audit] Failed to log: ${action}`);
    }
  }

  trace(message: string, data?: Record<string, unknown>): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level: "trace",
      agent: this.agentId,
      tenant: this.tenantId,
      message,
      ...data,
    };
    console.log(JSON.stringify(entry));
  }

  info(message: string, data?: Record<string, unknown>): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level: "info",
      agent: this.agentId,
      tenant: this.tenantId,
      message,
      ...data,
    };
    console.log(JSON.stringify(entry));
  }

  warn(message: string, data?: Record<string, unknown>): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level: "warn",
      agent: this.agentId,
      tenant: this.tenantId,
      message,
      ...data,
    };
    console.warn(JSON.stringify(entry));
  }

  error(message: string, data?: Record<string, unknown>): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level: "error",
      agent: this.agentId,
      tenant: this.tenantId,
      message,
      ...data,
    };
    console.error(JSON.stringify(entry));
  }
}
