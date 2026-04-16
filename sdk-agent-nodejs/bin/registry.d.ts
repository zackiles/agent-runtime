export declare class AgentRegistry {
    private static _instance;
    private controlPlaneUrl;
    private token;
    private tenantId;
    private fuseMounted;
    constructor(opts: {
        controlPlaneUrl: string;
        token: string;
        tenantId: string;
    });
    static init(opts: ConstructorParameters<typeof AgentRegistry>[0]): void;
    static get instance(): AgentRegistry;
    rules(slug: string, version?: string): Promise<string | null>;
    skills(slug: string, version?: string): Promise<string | null>;
    listRules(): Promise<string[]>;
    listSkills(): Promise<string[]>;
    listEntityFiles(type: "agents" | "tools", slug: string, version?: string): Promise<string[]>;
    downloadEntityFile(type: "agents" | "tools", slug: string, filename: string, dest: string, version?: string): Promise<boolean>;
    downloadAllEntityFiles(type: "agents" | "tools", slug: string, destDir: string, version?: string): Promise<string[]>;
    private readFuse;
    private listFuse;
    private readApi;
    private listApi;
}
