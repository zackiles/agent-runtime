"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  AgentAudit: () => AgentAudit,
  AgentEnvironment: () => AgentEnvironment,
  AgentRegistry: () => AgentRegistry,
  AgentSecrets: () => AgentSecrets,
  AgentSecurity: () => AgentSecurity,
  AgentSession: () => AgentSession,
  AgentStorage: () => AgentStorage,
  AgentTools: () => AgentTools,
  bootstrap: () => bootstrap,
  ensureToken: () => ensureToken
});
module.exports = __toCommonJS(index_exports);

// src/storage.ts
var fs = __toESM(require("fs"), 1);
var os = __toESM(require("os"), 1);
var path = __toESM(require("path"), 1);
var import_child_process = require("child_process");
var AgentStorage = class _AgentStorage {
  static _instance;
  controlPlaneUrl;
  token;
  bucket;
  tenantId;
  agentId;
  constructor(opts) {
    this.controlPlaneUrl = opts.controlPlaneUrl;
    this.token = opts.token;
    this.bucket = opts.bucket;
    this.tenantId = opts.tenantId;
    this.agentId = opts.agentId;
  }
  static init(opts) {
    _AgentStorage._instance = new _AgentStorage(opts);
  }
  static get instance() {
    if (!_AgentStorage._instance) {
      throw new Error("AgentStorage not initialized");
    }
    return _AgentStorage._instance;
  }
  prefix() {
    return `${this.tenantId}/agent/${this.agentId}/files`;
  }
  headers() {
    return {
      "Authorization": `Bearer ${this.token}`,
      "X-Tenant": this.tenantId
    };
  }
  async sign(gcsPath, method, contentType) {
    const params = new URLSearchParams({
      path: gcsPath,
      method,
      ttl: "300"
    });
    if (contentType) params.set("contentType", contentType);
    const res = await fetch(
      `${this.controlPlaneUrl}/storage/sign?${params}`,
      { headers: this.headers() }
    );
    if (!res.ok) {
      throw new Error(`Failed to get signed URL: ${res.status}`);
    }
    const json = await res.json();
    return json.url;
  }
  async write(filePath, data) {
    const fullPath = `${this.prefix()}/${filePath}`;
    const url = await this.sign(
      fullPath,
      "PUT",
      "application/octet-stream"
    );
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: data
    });
    if (!res.ok) {
      throw new Error(`Failed to write ${filePath}: ${res.status}`);
    }
  }
  async read(filePath) {
    const fullPath = `${this.prefix()}/${filePath}`;
    const url = await this.sign(fullPath, "GET");
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to read ${filePath}: ${res.status}`);
    }
    return await res.text();
  }
  async list(prefix = "") {
    const fullPrefix = `${this.prefix()}/${prefix}`;
    const res = await fetch(
      `${this.controlPlaneUrl}/storage/list?bucket=${this.bucket}&prefix=${encodeURIComponent(fullPrefix)}`,
      { headers: this.headers() }
    );
    if (!res.ok) return [];
    return await res.json();
  }
  async exists(filePath) {
    const fullPath = `${this.prefix()}/${filePath}`;
    const res = await fetch(
      `${this.controlPlaneUrl}/storage/exists?bucket=${this.bucket}&path=${encodeURIComponent(fullPath)}`,
      { headers: this.headers() }
    );
    return res.ok;
  }
  async remove(filePath) {
    const fullPath = `${this.prefix()}/${filePath}`;
    await fetch(
      `${this.controlPlaneUrl}/storage?bucket=${this.bucket}&path=${encodeURIComponent(fullPath)}`,
      {
        method: "DELETE",
        headers: this.headers()
      }
    );
  }
  async pull(remotePath, localDir) {
    const files = await this.list(remotePath);
    fs.mkdirSync(localDir, { recursive: true });
    for (const file of files) {
      const relative2 = file.slice(
        file.indexOf(remotePath) + remotePath.length + 1
      );
      if (!relative2) continue;
      const dest = path.join(localDir, relative2);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const data = await this.read(`${remotePath}/${relative2}`);
      fs.writeFileSync(dest, data);
    }
  }
  async push(localDir, remotePath) {
    const entries = this.walkDir(localDir);
    for (const filePath of entries) {
      const relative2 = path.relative(localDir, filePath);
      const data = fs.readFileSync(filePath, "utf-8");
      await this.write(`${remotePath}/${relative2}`, data);
    }
  }
  async listRaw(prefix) {
    const res = await fetch(
      `${this.controlPlaneUrl}/storage/list?bucket=${this.bucket}&prefix=${encodeURIComponent(prefix)}`,
      { headers: this.headers() }
    );
    if (!res.ok) return [];
    return await res.json();
  }
  async readRaw(rawPath) {
    const url = await this.sign(rawPath, "GET");
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to read ${rawPath}: ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
  async pullRaw(remotePath, localDir) {
    const files = await this.listRaw(remotePath);
    fs.mkdirSync(localDir, { recursive: true });
    for (const file of files) {
      const relative2 = file.slice(
        file.indexOf(remotePath) + remotePath.length + 1
      );
      if (!relative2) continue;
      const dest = path.join(localDir, relative2);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const data = await this.readRaw(file);
      fs.writeFileSync(dest, data);
    }
  }
  async writeRaw(rawPath, data) {
    const url = await this.sign(
      rawPath,
      "PUT",
      "application/octet-stream"
    );
    const body = typeof data === "string" ? data : new Uint8Array(data);
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body
    });
    if (!res.ok) {
      throw new Error(`Failed to write ${rawPath}: ${res.status}`);
    }
  }
  async pushRaw(localDir, remotePath) {
    const entries = this.walkDir(localDir);
    for (const filePath of entries) {
      const relative2 = path.relative(localDir, filePath);
      const data = fs.readFileSync(filePath);
      await this.writeRaw(`${remotePath}/${relative2}`, data);
    }
  }
  async pushArchive(localDir, remotePath) {
    const tmp = path.join(os.tmpdir(), `ar-${Date.now()}.tar.gz`);
    try {
      await new Promise((resolve, reject) => {
        const proc = (0, import_child_process.spawn)("tar", [
          "-czf",
          tmp,
          "--exclude",
          "node_modules",
          "--exclude",
          ".git",
          "--exclude",
          ".env",
          "-C",
          localDir,
          "."
        ]);
        proc.on(
          "close",
          (code) => code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))
        );
        proc.on("error", reject);
      });
      const url = await this.sign(remotePath, "PUT", "application/gzip");
      const data = fs.readFileSync(tmp);
      const res = await fetch(url, {
        method: "PUT",
        headers: {
          "Content-Type": "application/gzip",
          "Content-Length": String(data.byteLength)
        },
        body: new Uint8Array(data)
      });
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
      }
    }
  }
  async pullArchive(remotePath, localDir) {
    const { pipeline } = await import("stream/promises");
    const { Readable } = await import("stream");
    const url = await this.sign(remotePath, "GET");
    fs.mkdirSync(localDir, { recursive: true });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const proc = (0, import_child_process.spawn)("tar", ["-xzf", "-", "-C", localDir], {
      stdio: ["pipe", "ignore", "pipe"]
    });
    await pipeline(Readable.fromWeb(res.body), proc.stdin);
    await new Promise((resolve, reject) => {
      proc.on(
        "close",
        (code) => code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))
      );
      proc.on("error", reject);
    });
  }
  static SKIP = /* @__PURE__ */ new Set([
    "node_modules",
    ".git",
    ".env",
    ".cache",
    ".next"
  ]);
  walkDir(dir) {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (_AgentStorage.SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.walkDir(full));
      } else {
        results.push(full);
      }
    }
    return results;
  }
};

// src/tools.ts
var import_child_process2 = require("child_process");
var import_fs = require("fs");
var import_path = require("path");

// src/secrets.ts
var AgentSecrets = class _AgentSecrets {
  static _instance;
  controlPlaneUrl;
  token;
  constructor(controlPlaneUrl, token) {
    this.controlPlaneUrl = controlPlaneUrl;
    this.token = token;
  }
  static init(controlPlaneUrl, token) {
    _AgentSecrets._instance = new _AgentSecrets(controlPlaneUrl, token);
  }
  static get instance() {
    if (!_AgentSecrets._instance) {
      throw new Error("AgentSecrets not initialized");
    }
    return _AgentSecrets._instance;
  }
  async get(name) {
    const envValue = process.env[name.toUpperCase().replace(/-/g, "_")];
    if (envValue) return envValue;
    try {
      const res = await fetch(`${this.controlPlaneUrl}/secrets/${name}`, {
        headers: { "Authorization": `Bearer ${this.token}` }
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.value ?? null;
    } catch {
      return null;
    }
  }
  async set(name, value) {
    await fetch(`${this.controlPlaneUrl}/secrets`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ name, value })
    });
  }
  async list() {
    const res = await fetch(`${this.controlPlaneUrl}/secrets`, {
      headers: { "Authorization": `Bearer ${this.token}` }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.map((s) => s.name);
  }
};

// src/tools.ts
var PASSTHROUGH_VARS = [
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "NODE_ENV"
];
function findExecutable(dir, prefix) {
  try {
    const entries = (0, import_fs.readdirSync)(dir);
    for (const entry of entries) {
      const lower = entry.toLowerCase();
      if (lower === prefix || lower.startsWith(`${prefix}.`) && lower !== `${prefix}.json`) {
        return (0, import_path.join)(dir, entry);
      }
    }
  } catch {
  }
  return null;
}
var AgentTools = class _AgentTools {
  static _instance;
  toolsDir;
  configs;
  constructor(toolsDir = "/bin/tools", configs) {
    this.toolsDir = toolsDir;
    this.configs = /* @__PURE__ */ new Map();
    if (configs) {
      for (const c of configs) this.configs.set(c.slug, c);
    }
  }
  static init(toolsDir, configs) {
    _AgentTools._instance = new _AgentTools(toolsDir, configs);
  }
  static get instance() {
    if (!_AgentTools._instance) throw new Error("AgentTools not initialized");
    return _AgentTools._instance;
  }
  config(name) {
    return this.configs.get(name) ?? null;
  }
  resolveBinary(name) {
    const containerDir = (0, import_path.join)("/app/tools", name);
    const containerPath = findExecutable(containerDir, "tool");
    if (containerPath) return containerPath;
    const toolDir = (0, import_path.join)(this.toolsDir, name);
    const path3 = findExecutable(toolDir, "tool");
    if (path3) return path3;
    const installPath = findExecutable(toolDir, "install");
    if (installPath) {
      (0, import_child_process2.execSync)(installPath, {
        cwd: toolDir,
        encoding: "utf-8",
        env: {
          ...process.env,
          TOOLS_DIR: toolDir
        }
      });
      const retryPath = findExecutable(toolDir, "tool");
      if (retryPath) return retryPath;
    }
    return name;
  }
  run(name, input, opts) {
    const timeout = opts?.timeout ?? 12e4;
    const binary = this.resolveBinary(name);
    const tc = this.configs.get(name);
    const flags = tc?.flags ?? [];
    const shared = {
      timeout,
      encoding: "utf-8",
      env: this.resolveEnv(name),
      ...opts?.cwd ? { cwd: opts.cwd } : {}
    };
    if (flags.length > 0) {
      return (0, import_child_process2.execFileSync)(binary, [...flags, input], {
        ...shared,
        maxBuffer: 50 * 1024 * 1024
      }).trim();
    }
    return (0, import_child_process2.execSync)(binary, { ...shared, input }).trim();
  }
  async exec(name, args, input) {
    const { spawn: spawn2 } = await import("child_process");
    const binary = this.resolveBinary(name);
    return new Promise((resolve, reject) => {
      const proc = spawn2(binary, args, {
        env: this.resolveEnv(name),
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => stdout += d.toString());
      proc.stderr.on("data", (d) => stderr += d.toString());
      if (input) {
        proc.stdin.write(input);
      }
      proc.stdin.end();
      proc.on(
        "close",
        (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code })
      );
      proc.on("error", reject);
    });
  }
  async credentials(...names) {
    const secrets = AgentSecrets.instance;
    const result = {};
    for (const name of names) {
      result[name] = await secrets.get(name);
    }
    return result;
  }
  async warmSecrets(name) {
    const tc = this.configs.get(name);
    if (!tc?.env) return;
    let secrets = null;
    try {
      secrets = AgentSecrets.instance;
    } catch {
      return;
    }
    for (const template of Object.values(tc.env)) {
      const match = template.match(/^\$\{(\w+)\}$/);
      if (!match) continue;
      const envKey = match[1];
      if (process.env[envKey]) continue;
      const secretName = envKey.toLowerCase().replace(/_/g, "-");
      const value = await secrets.get(secretName);
      if (value) process.env[envKey] = value;
    }
  }
  resolveEnv(name) {
    const tc = this.configs.get(name);
    const toolDir = (0, import_path.join)(this.toolsDir, name);
    if (!tc?.env || Object.keys(tc.env).length === 0) {
      return {
        ...process.env,
        PATH: `${toolDir}:${this.toolsDir}:${process.env.PATH ?? ""}`
      };
    }
    const env = {
      PATH: `${toolDir}:${this.toolsDir}:${process.env.PATH ?? ""}`
    };
    for (const key of PASSTHROUGH_VARS) {
      if (process.env[key]) env[key] = process.env[key];
    }
    for (const [key, template] of Object.entries(tc.env)) {
      const value = template.replace(
        /\$\{(\w+)\}/g,
        (_, v) => process.env[v] ?? ""
      );
      if (value) env[key] = value;
    }
    return env;
  }
};

// src/session.ts
var AgentSession = class _AgentSession {
  static _instance;
  email;
  userId;
  root;
  previous;
  current;
  constructor(opts) {
    this.email = opts.email;
    this.userId = opts.userId;
    this.root = opts.root;
    this.previous = opts.previous ?? null;
    this.current = opts.current;
  }
  static init(opts) {
    _AgentSession._instance = new _AgentSession(opts);
  }
  static get instance() {
    if (!_AgentSession._instance) {
      throw new Error("AgentSession not initialized");
    }
    return _AgentSession._instance;
  }
  header(name) {
    return this.current.headers[name.toLowerCase()];
  }
  get isSubAgent() {
    return this.previous !== null;
  }
};

// src/environment.ts
var AgentEnvironment = class _AgentEnvironment {
  static _instance;
  tenant;
  agentName;
  agentVersion;
  agentSlug;
  department;
  team;
  owners;
  publishedAt;
  updatedAt;
  subsystem;
  visibility;
  registryType;
  constructor(opts) {
    this.tenant = opts.tenant;
    this.agentName = opts.agentName;
    this.agentVersion = opts.agentVersion;
    this.agentSlug = opts.agentSlug;
    this.department = opts.department;
    this.team = opts.team;
    this.owners = opts.owners;
    this.publishedAt = opts.publishedAt;
    this.updatedAt = opts.updatedAt;
    this.subsystem = opts.subsystem ?? null;
    this.visibility = opts.visibility ?? "private";
    this.registryType = opts.registryType ?? "private";
  }
  static init(opts) {
    _AgentEnvironment._instance = new _AgentEnvironment(opts);
  }
  static get instance() {
    if (!_AgentEnvironment._instance) {
      throw new Error("AgentEnvironment not initialized");
    }
    return _AgentEnvironment._instance;
  }
  get isPublicRegistry() {
    return this.registryType === "public";
  }
  get isPrivateRegistry() {
    return this.registryType === "private";
  }
  get isDevelopment() {
    return this.tenant === "development";
  }
  get isProduction() {
    return this.tenant === "production";
  }
};

// src/security.ts
function buildMatcher(match) {
  if (typeof match === "string") {
    const re = new RegExp(match, "i");
    return (_k, v) => re.test(v);
  }
  if (match instanceof RegExp) {
    return (_k, v) => match.test(v);
  }
  const keyRe = match.key ? typeof match.key === "string" ? new RegExp(match.key, "i") : match.key : null;
  const valRe = match.value ? typeof match.value === "string" ? new RegExp(match.value, "i") : match.value : null;
  return (k, v) => {
    const keyMatch = keyRe ? keyRe.test(k) : true;
    const valMatch = valRe ? valRe.test(v) : true;
    return keyMatch && valMatch;
  };
}
function buildReplacer(replace) {
  if (!replace) return (_k, _v) => "[REDACTED]";
  if (typeof replace === "string") return (_k, _v) => replace;
  if (typeof replace === "function") return replace;
  const valReplacer = replace.value;
  if (typeof valReplacer === "function") return (_k, v) => valReplacer(_k, v);
  return (_k, _v) => valReplacer ?? "[REDACTED]";
}
var DEFAULT_RULES = [
  {
    name: "api-keys",
    match: { key: /(api.?key|api.?secret|api.?token)/i },
    direction: "both"
  },
  {
    name: "passwords",
    match: { key: /(password|passwd|secret)/i },
    direction: "both"
  },
  {
    name: "bearer-tokens",
    match: /Bearer\s+[A-Za-z0-9\-._~+\/]+=*/,
    replace: "Bearer [REDACTED]",
    direction: "both"
  },
  {
    name: "credit-cards",
    match: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,
    direction: "both"
  },
  {
    name: "ssn",
    match: /\b\d{3}-\d{2}-\d{4}\b/,
    direction: "both"
  },
  {
    name: "emails-in-values",
    match: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
    replace: "[EMAIL_REDACTED]",
    direction: "output"
  }
];
var AgentSecurity = class _AgentSecurity {
  static _instance;
  rules = [];
  counter = 0;
  constructor() {
    for (const cfg of DEFAULT_RULES) {
      this.add(cfg);
    }
  }
  static init() {
    _AgentSecurity._instance = new _AgentSecurity();
  }
  static get instance() {
    if (!_AgentSecurity._instance) {
      throw new Error("AgentSecurity not initialized");
    }
    return _AgentSecurity._instance;
  }
  add(config) {
    const id = `rule-${++this.counter}`;
    this.rules.push({
      id,
      name: config.name,
      direction: config.direction ?? "both",
      priority: config.priority ?? this.counter,
      matcher: buildMatcher(config.match),
      replacer: buildReplacer(config.replace)
    });
    this.rules.sort((a, b) => a.priority - b.priority);
    return id;
  }
  remove(id) {
    this.rules = this.rules.filter((r) => r.id !== id);
  }
  reorder(ids) {
    const map = new Map(this.rules.map((r) => [r.id, r]));
    this.rules = ids.map((id) => map.get(id)).filter((r) => !!r);
  }
  isSanitized(data, direction = "both") {
    const applicable = this.rules.filter(
      (r) => r.direction === "both" || r.direction === direction || direction === "both"
    );
    if (typeof data === "string") {
      return !applicable.some((r) => r.matcher("", data));
    }
    return !this.objectHasMatch(data, applicable);
  }
  sanitize(data, direction = "both") {
    const applicable = this.rules.filter(
      (r) => r.direction === "both" || r.direction === direction || direction === "both"
    );
    if (typeof data === "string") {
      return this.sanitizeString(data, applicable);
    }
    return this.sanitizeObject(data, applicable);
  }
  sanitizeString(str, rules) {
    let result = str;
    for (const rule of rules) {
      if (rule.matcher("", result)) {
        result = rule.replacer("", result);
      }
    }
    return result;
  }
  sanitizeObject(obj, rules) {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "string") {
        let sanitized = value;
        for (const rule of rules) {
          if (rule.matcher(key, sanitized)) {
            sanitized = rule.replacer(key, sanitized);
          }
        }
        result[key] = sanitized;
      } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        result[key] = this.sanitizeObject(
          value,
          rules
        );
      } else if (Array.isArray(value)) {
        result[key] = value.map(
          (item) => typeof item === "string" ? this.sanitizeString(item, rules) : item !== null && typeof item === "object" ? this.sanitizeObject(item, rules) : item
        );
      } else {
        result[key] = value;
      }
    }
    return result;
  }
  objectHasMatch(obj, rules) {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "string") {
        if (rules.some((r) => r.matcher(key, value))) return true;
      } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        if (this.objectHasMatch(value, rules)) {
          return true;
        }
      }
    }
    return false;
  }
};

// src/audit.ts
var AgentAudit = class _AgentAudit {
  static _instance;
  controlPlaneUrl;
  token;
  agentId;
  tenantId;
  constructor(opts) {
    this.controlPlaneUrl = opts.controlPlaneUrl;
    this.token = opts.token;
    this.agentId = opts.agentId;
    this.tenantId = opts.tenantId;
  }
  static init(opts) {
    _AgentAudit._instance = new _AgentAudit(opts);
  }
  static get instance() {
    if (!_AgentAudit._instance) {
      throw new Error("AgentAudit not initialized");
    }
    return _AgentAudit._instance;
  }
  async log(action, metadata) {
    try {
      await fetch(`${this.controlPlaneUrl}/audit`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.token}`,
          "Content-Type": "application/json",
          "X-Tenant": this.tenantId
        },
        body: JSON.stringify({
          entityType: "agent",
          entityId: this.agentId,
          action,
          metadata
        })
      });
    } catch {
      console.error(`[ar-audit] Failed to log: ${action}`);
    }
  }
  trace(message, data) {
    const entry = {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      level: "trace",
      agent: this.agentId,
      tenant: this.tenantId,
      message,
      ...data
    };
    console.log(JSON.stringify(entry));
  }
  info(message, data) {
    const entry = {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      level: "info",
      agent: this.agentId,
      tenant: this.tenantId,
      message,
      ...data
    };
    console.log(JSON.stringify(entry));
  }
  warn(message, data) {
    const entry = {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      level: "warn",
      agent: this.agentId,
      tenant: this.tenantId,
      message,
      ...data
    };
    console.warn(JSON.stringify(entry));
  }
  error(message, data) {
    const entry = {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      level: "error",
      agent: this.agentId,
      tenant: this.tenantId,
      message,
      ...data
    };
    console.error(JSON.stringify(entry));
  }
};

// src/registry.ts
var fs2 = __toESM(require("fs"), 1);
var path2 = __toESM(require("path"), 1);
var FUSE_MOUNT = "/registry";
var AgentRegistry = class _AgentRegistry {
  static _instance;
  controlPlaneUrl;
  token;
  tenantId;
  fuseMounted;
  constructor(opts) {
    this.controlPlaneUrl = opts.controlPlaneUrl;
    this.token = opts.token;
    this.tenantId = opts.tenantId;
    this.fuseMounted = fs2.existsSync(FUSE_MOUNT) && fs2.statSync(FUSE_MOUNT).isDirectory();
  }
  static init(opts) {
    _AgentRegistry._instance = new _AgentRegistry(opts);
  }
  static get instance() {
    if (!_AgentRegistry._instance) {
      throw new Error("AgentRegistry not initialized");
    }
    return _AgentRegistry._instance;
  }
  async rules(slug, version = "0.0.1") {
    if (this.fuseMounted) {
      return this.readFuse("rules", slug, version, "rule.md");
    }
    return this.readApi("rules", slug, version);
  }
  async skills(slug, version = "0.0.1") {
    if (this.fuseMounted) {
      return this.readFuse("skills", slug, version, "skill.md");
    }
    return this.readApi("skills", slug, version);
  }
  async listRules() {
    if (this.fuseMounted) {
      return this.listFuse("rules");
    }
    return this.listApi("rules");
  }
  async listSkills() {
    if (this.fuseMounted) {
      return this.listFuse("skills");
    }
    return this.listApi("skills");
  }
  async listEntityFiles(type, slug, version = "0.0.1") {
    const prefix = `${this.tenantId}/${type}/${slug}/${version}/files/`;
    const res = await fetch(
      `${this.controlPlaneUrl}/storage/list?prefix=${encodeURIComponent(prefix)}`,
      { headers: { Authorization: `Bearer ${this.token}` } }
    );
    if (!res.ok) return [];
    const paths = await res.json();
    return paths.map((p) => p.slice(prefix.length)).filter(Boolean);
  }
  async downloadEntityFile(type, slug, filename, dest, version = "0.0.1") {
    const gcsPath = `${this.tenantId}/${type}/${slug}/${version}/files/${filename}`;
    const params = new URLSearchParams({
      path: gcsPath,
      method: "GET",
      ttl: "600"
    });
    const signRes = await fetch(
      `${this.controlPlaneUrl}/storage/sign?${params}`,
      { headers: { Authorization: `Bearer ${this.token}` } }
    );
    if (!signRes.ok) return false;
    const { url } = await signRes.json();
    const dataRes = await fetch(url);
    if (!dataRes.ok) return false;
    const buf = Buffer.from(await dataRes.arrayBuffer());
    fs2.mkdirSync(path2.dirname(dest), { recursive: true });
    fs2.writeFileSync(dest, buf);
    return true;
  }
  async downloadAllEntityFiles(type, slug, destDir, version = "0.0.1") {
    const files = await this.listEntityFiles(type, slug, version);
    const downloaded = [];
    for (const name of files) {
      const dest = path2.join(destDir, name);
      if (await this.downloadEntityFile(type, slug, name, dest, version)) {
        downloaded.push(dest);
      }
    }
    return downloaded;
  }
  readFuse(type, slug, version, filename) {
    const filePath = path2.join(
      FUSE_MOUNT,
      this.tenantId,
      type,
      slug,
      version,
      filename
    );
    try {
      return fs2.readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }
  listFuse(type) {
    const dir = path2.join(FUSE_MOUNT, this.tenantId, type);
    try {
      return fs2.readdirSync(dir).filter((entry) => {
        return fs2.statSync(path2.join(dir, entry)).isDirectory();
      });
    } catch {
      return [];
    }
  }
  async readApi(type, slug, _version) {
    if (!this.controlPlaneUrl) return null;
    try {
      const res = await fetch(
        `${this.controlPlaneUrl}/${type}/${slug}`,
        { headers: { Authorization: `Bearer ${this.token}` } }
      );
      if (!res.ok) return null;
      const data = await res.json();
      return data.content ?? null;
    } catch {
      return null;
    }
  }
  async listApi(type) {
    if (!this.controlPlaneUrl) return [];
    try {
      const res = await fetch(
        `${this.controlPlaneUrl}/${type}`,
        { headers: { Authorization: `Bearer ${this.token}` } }
      );
      if (!res.ok) return [];
      const data = await res.json();
      return data.map((d) => d.slug ?? "").filter(Boolean);
    } catch {
      return [];
    }
  }
};

// src/bootstrap.ts
function bootstrap(config, handler) {
  AgentStorage.init({
    controlPlaneUrl: config.controlPlaneUrl,
    token: config.token,
    bucket: config.bucket,
    tenantId: config.tenantId,
    agentId: config.agentId
  });
  AgentTools.init(config.toolsDir, config.tools);
  AgentEnvironment.init({
    tenant: config.tenantId,
    agentName: config.agentName,
    agentVersion: config.agentVersion,
    agentSlug: config.agentSlug,
    department: config.department,
    team: config.team,
    owners: config.owners,
    publishedAt: config.publishedAt,
    updatedAt: config.updatedAt,
    subsystem: config.subsystem
  });
  AgentSecurity.init();
  AgentSecrets.init(config.controlPlaneUrl, config.token);
  AgentAudit.init({
    controlPlaneUrl: config.controlPlaneUrl,
    token: config.token,
    agentId: config.agentId,
    tenantId: config.tenantId
  });
  const security = AgentSecurity.instance;
  const audit = AgentAudit.instance;
  const tools = AgentTools.instance;
  let secretsWarmed = false;
  return async (request) => {
    if (!secretsWarmed) {
      secretsWarmed = true;
      for (const tc of config.tools ?? []) {
        await tools.warmSecrets(tc.slug);
      }
    }
    const startTime = Date.now();
    let body = null;
    try {
      body = await request.clone().json().catch(() => null);
    } catch {
    }
    AgentSession.init({
      email: request.headers.get("x-user-email") || "unknown",
      userId: request.headers.get("x-user-id") || "unknown",
      root: {
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers.entries()),
        body
      },
      current: {
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers.entries()),
        body
      }
    });
    if (body && typeof body === "object") {
      const sanitized = security.sanitize(
        body,
        "input"
      );
      body = sanitized;
    }
    audit.trace("request-received", {
      method: request.method,
      url: request.url
    });
    try {
      const response = await handler(request);
      const duration = Date.now() - startTime;
      audit.trace("request-completed", {
        status: response.status,
        duration
      });
      return response;
    } catch (err) {
      const duration = Date.now() - startTime;
      const message = err instanceof Error ? err.message : String(err);
      audit.error("request-failed", { error: message, duration });
      return new Response(
        JSON.stringify({ error: message }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" }
        }
      );
    }
  };
}
async function ensureToken() {
  if (process.env.AR_TOKEN) return;
  const cpUrl = process.env.AR_CONTROL_PLANE_URL;
  if (!cpUrl) return;
  try {
    const url = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=" + encodeURIComponent(cpUrl);
    const res = await fetch(url, {
      headers: { "Metadata-Flavor": "Google" }
    });
    if (res.ok) {
      process.env.AR_TOKEN = await res.text();
    }
  } catch {
    return;
  }
  if (!process.env.AR_TOKEN) return;
  const tenantId = process.env.AR_TENANT_ID;
  if (!tenantId) return;
  const agentId = process.env.AR_AGENT_SLUG || process.env.AR_AGENT_ID || "unknown";
  AgentSecrets.init(cpUrl, process.env.AR_TOKEN);
  AgentAudit.init({
    controlPlaneUrl: cpUrl,
    token: process.env.AR_TOKEN,
    agentId,
    tenantId
  });
  AgentStorage.init({
    controlPlaneUrl: cpUrl,
    token: process.env.AR_TOKEN,
    bucket: process.env.AR_BUCKET || "",
    tenantId,
    agentId
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AgentAudit,
  AgentEnvironment,
  AgentRegistry,
  AgentSecrets,
  AgentSecurity,
  AgentSession,
  AgentStorage,
  AgentTools,
  bootstrap,
  ensureToken
});
//# sourceMappingURL=index.cjs.map
