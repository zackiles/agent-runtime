export declare class AgentStorage {
    private static _instance;
    private controlPlaneUrl;
    private token;
    private bucket;
    private tenantId;
    private agentId;
    constructor(opts: {
        controlPlaneUrl: string;
        token: string;
        bucket: string;
        tenantId: string;
        agentId: string;
    });
    static init(opts: ConstructorParameters<typeof AgentStorage>[0]): void;
    static get instance(): AgentStorage;
    private prefix;
    private headers;
    private sign;
    write(filePath: string, data: string): Promise<void>;
    read(filePath: string): Promise<string>;
    list(prefix?: string): Promise<string[]>;
    exists(filePath: string): Promise<boolean>;
    remove(filePath: string): Promise<void>;
    pull(remotePath: string, localDir: string): Promise<void>;
    push(localDir: string, remotePath: string): Promise<void>;
    listRaw(prefix: string): Promise<string[]>;
    readRaw(rawPath: string): Promise<Buffer>;
    pullRaw(remotePath: string, localDir: string): Promise<void>;
    writeRaw(rawPath: string, data: string | Buffer | Uint8Array): Promise<void>;
    pushRaw(localDir: string, remotePath: string): Promise<void>;
    pushArchive(localDir: string, remotePath: string): Promise<void>;
    pullArchive(remotePath: string, localDir: string): Promise<void>;
    private static SKIP;
    private walkDir;
}
