export class AgentSecrets {
  private static _instance: AgentSecrets;
  private controlPlaneUrl: string;
  private token: string;

  constructor(controlPlaneUrl: string, token: string) {
    this.controlPlaneUrl = controlPlaneUrl;
    this.token = token;
  }

  static init(controlPlaneUrl: string, token: string): void {
    AgentSecrets._instance = new AgentSecrets(controlPlaneUrl, token);
  }

  static get instance(): AgentSecrets {
    if (!AgentSecrets._instance) {
      throw new Error("AgentSecrets not initialized");
    }
    return AgentSecrets._instance;
  }

  async get(name: string): Promise<string | null> {
    const envValue = process.env[name.toUpperCase().replace(/-/g, "_")];
    if (envValue) return envValue;

    try {
      const res = await fetch(`${this.controlPlaneUrl}/secrets/${name}`, {
        headers: { "Authorization": `Bearer ${this.token}` },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { value?: string };
      return data.value ?? null;
    } catch {
      return null;
    }
  }

  async set(name: string, value: string): Promise<void> {
    await fetch(`${this.controlPlaneUrl}/secrets`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, value }),
    });
  }

  async list(): Promise<string[]> {
    const res = await fetch(`${this.controlPlaneUrl}/secrets`, {
      headers: { "Authorization": `Bearer ${this.token}` },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as Array<{ name: string }>;
    return data.map((s) => s.name);
  }
}
