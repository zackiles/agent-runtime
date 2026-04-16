export declare class AgentSecrets {
    private static _instance;
    private controlPlaneUrl;
    private token;
    constructor(controlPlaneUrl: string, token: string);
    static init(controlPlaneUrl: string, token: string): void;
    static get instance(): AgentSecrets;
    get(name: string): Promise<string | null>;
    set(name: string, value: string): Promise<void>;
    list(): Promise<string[]>;
}
