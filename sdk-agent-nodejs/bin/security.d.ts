type ReplacerFn = (key: string, value: string) => string;
type SanitizerConfig = {
    name: string;
    match: string | RegExp | {
        key?: string | RegExp;
        value?: string | RegExp;
    };
    replace?: string | ReplacerFn | {
        key?: string;
        value?: string | ReplacerFn;
    };
    direction?: "input" | "output" | "both";
    priority?: number;
};
export declare class AgentSecurity {
    private static _instance;
    private rules;
    private counter;
    constructor();
    static init(): void;
    static get instance(): AgentSecurity;
    add(config: SanitizerConfig): string;
    remove(id: string): void;
    reorder(ids: string[]): void;
    isSanitized(data: string | Record<string, unknown>, direction?: "input" | "output" | "both"): boolean;
    sanitize(data: string | Record<string, unknown>, direction?: "input" | "output" | "both"): string | Record<string, unknown>;
    private sanitizeString;
    private sanitizeObject;
    private objectHasMatch;
}
export {};
