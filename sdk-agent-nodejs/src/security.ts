type MatcherFn = (key: string, value: string) => boolean;
type ReplacerFn = (key: string, value: string) => string;

type SanitizerRule = {
  id: string;
  name: string;
  direction: "input" | "output" | "both";
  priority: number;
  matcher: MatcherFn;
  replacer: ReplacerFn;
};

type SanitizerConfig = {
  name: string;
  match: string | RegExp | { key?: string | RegExp; value?: string | RegExp };
  replace?: string | ReplacerFn | { key?: string; value?: string | ReplacerFn };
  direction?: "input" | "output" | "both";
  priority?: number;
};

function buildMatcher(
  match: SanitizerConfig["match"],
): MatcherFn {
  if (typeof match === "string") {
    const re = new RegExp(match, "i");
    return (_k, v) => re.test(v);
  }
  if (match instanceof RegExp) {
    return (_k, v) => match.test(v);
  }
  const keyRe = match.key
    ? typeof match.key === "string" ? new RegExp(match.key, "i") : match.key
    : null;
  const valRe = match.value
    ? typeof match.value === "string"
      ? new RegExp(match.value, "i")
      : match.value
    : null;
  return (k, v) => {
    const keyMatch = keyRe ? keyRe.test(k) : true;
    const valMatch = valRe ? valRe.test(v) : true;
    return keyMatch && valMatch;
  };
}

function buildReplacer(
  replace: SanitizerConfig["replace"],
): ReplacerFn {
  if (!replace) return (_k, _v) => "[REDACTED]";
  if (typeof replace === "string") return (_k, _v) => replace;
  if (typeof replace === "function") return replace;
  const valReplacer = replace.value;
  if (typeof valReplacer === "function") return (_k, v) => valReplacer(_k, v);
  return (_k, _v) => (valReplacer ?? "[REDACTED]");
}

const DEFAULT_RULES: SanitizerConfig[] = [
  {
    name: "api-keys",
    match: { key: /(api.?key|api.?secret|api.?token)/i },
    direction: "both",
  },
  {
    name: "passwords",
    match: { key: /(password|passwd|secret)/i },
    direction: "both",
  },
  {
    name: "bearer-tokens",
    match: /Bearer\s+[A-Za-z0-9\-._~+\/]+=*/,
    replace: "Bearer [REDACTED]",
    direction: "both",
  },
  {
    name: "credit-cards",
    match: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,
    direction: "both",
  },
  {
    name: "ssn",
    match: /\b\d{3}-\d{2}-\d{4}\b/,
    direction: "both",
  },
  {
    name: "emails-in-values",
    match: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
    replace: "[EMAIL_REDACTED]",
    direction: "output",
  },
];

export class AgentSecurity {
  private static _instance: AgentSecurity;
  private rules: SanitizerRule[] = [];
  private counter = 0;

  constructor() {
    for (const cfg of DEFAULT_RULES) {
      this.add(cfg);
    }
  }

  static init(): void {
    AgentSecurity._instance = new AgentSecurity();
  }

  static get instance(): AgentSecurity {
    if (!AgentSecurity._instance) {
      throw new Error("AgentSecurity not initialized");
    }
    return AgentSecurity._instance;
  }

  add(config: SanitizerConfig): string {
    const id = `rule-${++this.counter}`;
    this.rules.push({
      id,
      name: config.name,
      direction: config.direction ?? "both",
      priority: config.priority ?? this.counter,
      matcher: buildMatcher(config.match),
      replacer: buildReplacer(config.replace),
    });
    this.rules.sort((a, b) => a.priority - b.priority);
    return id;
  }

  remove(id: string): void {
    this.rules = this.rules.filter((r) => r.id !== id);
  }

  reorder(ids: string[]): void {
    const map = new Map(this.rules.map((r) => [r.id, r]));
    this.rules = ids
      .map((id) => map.get(id))
      .filter((r): r is SanitizerRule => !!r);
  }

  isSanitized(
    data: string | Record<string, unknown>,
    direction: "input" | "output" | "both" = "both",
  ): boolean {
    const applicable = this.rules.filter(
      (r) =>
        r.direction === "both" || r.direction === direction ||
        direction === "both",
    );
    if (typeof data === "string") {
      return !applicable.some((r) => r.matcher("", data));
    }
    return !this.objectHasMatch(data, applicable);
  }

  sanitize(
    data: string | Record<string, unknown>,
    direction: "input" | "output" | "both" = "both",
  ): string | Record<string, unknown> {
    const applicable = this.rules.filter(
      (r) =>
        r.direction === "both" || r.direction === direction ||
        direction === "both",
    );
    if (typeof data === "string") {
      return this.sanitizeString(data, applicable);
    }
    return this.sanitizeObject(data, applicable);
  }

  private sanitizeString(str: string, rules: SanitizerRule[]): string {
    let result = str;
    for (const rule of rules) {
      if (rule.matcher("", result)) {
        result = rule.replacer("", result);
      }
    }
    return result;
  }

  private sanitizeObject(
    obj: Record<string, unknown>,
    rules: SanitizerRule[],
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "string") {
        let sanitized = value;
        for (const rule of rules) {
          if (rule.matcher(key, sanitized)) {
            sanitized = rule.replacer(key, sanitized);
          }
        }
        result[key] = sanitized;
      } else if (
        value !== null && typeof value === "object" && !Array.isArray(value)
      ) {
        result[key] = this.sanitizeObject(
          value as Record<string, unknown>,
          rules,
        );
      } else if (Array.isArray(value)) {
        result[key] = value.map((item) =>
          typeof item === "string"
            ? this.sanitizeString(item, rules)
            : item !== null && typeof item === "object"
            ? this.sanitizeObject(item as Record<string, unknown>, rules)
            : item
        );
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  private objectHasMatch(
    obj: Record<string, unknown>,
    rules: SanitizerRule[],
  ): boolean {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "string") {
        if (rules.some((r) => r.matcher(key, value))) return true;
      } else if (
        value !== null && typeof value === "object" && !Array.isArray(value)
      ) {
        if (this.objectHasMatch(value as Record<string, unknown>, rules)) {
          return true;
        }
      }
    }
    return false;
  }
}
