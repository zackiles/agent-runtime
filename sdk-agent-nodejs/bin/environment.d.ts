export declare class AgentEnvironment {
    private static _instance;
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
    });
    static init(opts: ConstructorParameters<typeof AgentEnvironment>[0]): void;
    static get instance(): AgentEnvironment;
    get isPublicRegistry(): boolean;
    get isPrivateRegistry(): boolean;
    get isDevelopment(): boolean;
    get isProduction(): boolean;
}
