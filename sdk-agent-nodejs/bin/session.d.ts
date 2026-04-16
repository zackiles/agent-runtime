type RequestData = {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
};
export declare class AgentSession {
    private static _instance;
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
    });
    static init(opts: ConstructorParameters<typeof AgentSession>[0]): void;
    static get instance(): AgentSession;
    header(name: string): string | undefined;
    get isSubAgent(): boolean;
}
export {};
