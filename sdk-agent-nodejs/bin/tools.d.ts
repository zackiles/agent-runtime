type McpTransport = "stdio" | "http";
type McpConfig = {
    transport: McpTransport;
    command?: string;
    args?: string[];
    url?: string;
    headers?: Record<string, string>;
};
type ToolConfig = {
    name: string;
    slug: string;
    version: string;
    description?: string;
    type?: "stdio" | "mcp";
    mcp?: McpConfig;
    flags: string[];
    env: Record<string, string>;
};
export declare class AgentTools {
    private static _instance;
    private toolsDir;
    private configs;
    private mcpClients;
    constructor(toolsDir?: string, configs?: ToolConfig[]);
    static init(toolsDir?: string, configs?: ToolConfig[]): void;
    static get instance(): AgentTools;
    config(name: string): ToolConfig | null;
    isMcp(name: string): boolean;
    private getMcpClient;
    mcpList(name: string): Promise<
        Array<{ name: string; description?: string; inputSchema?: unknown }>
    >;
    mcpCall(
        name: string,
        toolName: string,
        args: Record<string, unknown>,
    ): Promise<string>;
    closeMcp(): void;
    private resolveBinary;
    run(name: string, input: string, opts?: {
        timeout?: number;
        cwd?: string;
    }): string;
    exec(name: string, args: string[], input?: string): Promise<{
        stdout: string;
        stderr: string;
        code: number;
    }>;
    credentials(...names: string[]): Promise<Record<string, string | null>>;
    warmSecrets(name: string): Promise<void>;
    private resolveEnv;
}
export type { McpConfig, McpTransport, ToolConfig };
