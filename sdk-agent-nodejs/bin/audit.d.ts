export declare class AgentAudit {
    private static _instance;
    private controlPlaneUrl;
    private token;
    private agentId;
    private tenantId;
    constructor(opts: {
        controlPlaneUrl: string;
        token: string;
        agentId: string;
        tenantId: string;
    });
    static init(opts: ConstructorParameters<typeof AgentAudit>[0]): void;
    static get instance(): AgentAudit;
    log(action: string, metadata?: Record<string, unknown>): Promise<void>;
    trace(message: string, data?: Record<string, unknown>): void;
    info(message: string, data?: Record<string, unknown>): void;
    warn(message: string, data?: Record<string, unknown>): void;
    error(message: string, data?: Record<string, unknown>): void;
}
