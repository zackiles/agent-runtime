type RequestData = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
};

export class AgentSession {
  private static _instance: AgentSession;
  readonly email: string;
  readonly userId: string;
  readonly root: RequestData;
  readonly previous: RequestData | null;
  readonly current: RequestData;

  constructor(opts: {
    email: string;
    userId: string;
    root: RequestData;
    previous?: RequestData;
    current: RequestData;
  }) {
    this.email = opts.email;
    this.userId = opts.userId;
    this.root = opts.root;
    this.previous = opts.previous ?? null;
    this.current = opts.current;
  }

  static init(opts: ConstructorParameters<typeof AgentSession>[0]): void {
    AgentSession._instance = new AgentSession(opts);
  }

  static get instance(): AgentSession {
    if (!AgentSession._instance) {
      throw new Error("AgentSession not initialized");
    }
    return AgentSession._instance;
  }

  header(name: string): string | undefined {
    return this.current.headers[name.toLowerCase()];
  }

  get isSubAgent(): boolean {
    return this.previous !== null;
  }
}
