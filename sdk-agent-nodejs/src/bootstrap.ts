import { AgentStorage } from "./storage.js";
import { AgentTools } from "./tools.js";
import type { ToolConfig } from "./tools.js";
import { AgentSession } from "./session.js";
import { AgentEnvironment } from "./environment.js";
import { AgentSecurity } from "./security.js";
import { AgentSecrets } from "./secrets.js";
import { AgentAudit } from "./audit.js";

type BootstrapConfig = {
  controlPlaneUrl: string;
  token: string;
  bucket: string;
  tenantId: string;
  agentId: string;
  agentName: string;
  agentVersion: string;
  agentSlug: string;
  department: string;
  team: string;
  owners: string[];
  publishedAt: string;
  updatedAt: string;
  subsystem?: string | null;
  toolsDir?: string;
  tools?: ToolConfig[];
};

type HandlerFn = (request: Request) => Promise<Response>;

function bootstrap(
  config: BootstrapConfig,
  handler: HandlerFn,
): HandlerFn {
  AgentStorage.init({
    controlPlaneUrl: config.controlPlaneUrl,
    token: config.token,
    bucket: config.bucket,
    tenantId: config.tenantId,
    agentId: config.agentId,
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
    subsystem: config.subsystem,
  });

  AgentSecurity.init();

  AgentSecrets.init(config.controlPlaneUrl, config.token);

  AgentAudit.init({
    controlPlaneUrl: config.controlPlaneUrl,
    token: config.token,
    agentId: config.agentId,
    tenantId: config.tenantId,
  });

  const security = AgentSecurity.instance;
  const audit = AgentAudit.instance;

  const tools = AgentTools.instance;
  let secretsWarmed = false;

  return async (request: Request): Promise<Response> => {
    if (!secretsWarmed) {
      secretsWarmed = true;
      for (const tc of config.tools ?? []) {
        await tools.warmSecrets(tc.slug);
      }
    }

    const startTime = Date.now();
    let body: unknown = null;
    try {
      body = await request.clone().json().catch(() => null);
    } catch {
      // non-JSON body
    }

    // IMPORTANT: These headers are informational, not authenticated identity.
    // Agent functions are IAM-gated (--no-allow-unauthenticated), so only
    // authorized invokers can reach this code. The CP puts user identity in
    // the JSON body, not these headers. Do not use these for authorization.
    AgentSession.init({
      email: request.headers.get("x-user-email") || "unknown",
      userId: request.headers.get("x-user-id") || "unknown",
      root: {
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers.entries()),
        body,
      },
      current: {
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers.entries()),
        body,
      },
    });

    if (body && typeof body === "object") {
      const sanitized = security.sanitize(
        body as Record<string, unknown>,
        "input",
      );
      body = sanitized;
    }

    audit.trace("request-received", {
      method: request.method,
      url: request.url,
    });

    try {
      const response = await handler(request);
      const duration = Date.now() - startTime;

      audit.trace("request-completed", {
        status: response.status,
        duration,
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
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  };
}

async function ensureToken(): Promise<void> {
  if (process.env.AR_TOKEN) return;
  const cpUrl = process.env.AR_CONTROL_PLANE_URL;
  if (!cpUrl) return;

  try {
    const url =
      "http://metadata.google.internal/computeMetadata/v1/" +
      "instance/service-accounts/default/identity?audience=" +
      encodeURIComponent(cpUrl);
    const res = await fetch(url, {
      headers: { "Metadata-Flavor": "Google" },
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
  const agentId =
    process.env.AR_AGENT_SLUG || process.env.AR_AGENT_ID || "unknown";

  AgentSecrets.init(cpUrl, process.env.AR_TOKEN);
  AgentAudit.init({
    controlPlaneUrl: cpUrl,
    token: process.env.AR_TOKEN,
    agentId,
    tenantId,
  });
  AgentStorage.init({
    controlPlaneUrl: cpUrl,
    token: process.env.AR_TOKEN,
    bucket: process.env.AR_BUCKET || "",
    tenantId,
    agentId,
  });
}

export { bootstrap, ensureToken };
export type { BootstrapConfig, HandlerFn };
