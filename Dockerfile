FROM denoland/deno:2.1.4

RUN apt-get update && apt-get install -y nodejs npm && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY default-settings.jsonc ./default-settings.jsonc
COPY deno.jsonc ./deno.jsonc

COPY web/package.json web/package-lock.json* ./web/
COPY web/vite.config.ts web/tsconfig.json web/index.html ./web/
COPY web/deno.jsonc web/mod.ts ./web/
COPY web/src/ web/src/
COPY web/dev/ web/dev/

WORKDIR /app/web
RUN npm ci && npx vite build
WORKDIR /app

COPY sdk-client-deno/deno.jsonc ./sdk-client-deno/
COPY sdk-client-deno/src/ sdk-client-deno/src/

COPY default-registry/tools/ default-registry/tools/

COPY docs/ docs/
COPY README.md ./README.md

COPY control-plane/deno.jsonc ./control-plane/
COPY control-plane/src/ control-plane/src/

RUN deno cache control-plane/src/mod.ts

RUN mkdir -p /data
VOLUME ["/data"]

# Infrastructure env vars (set at build time)
ENV AR_MODE=server
ENV PORT=8080
ENV AR_DB_PATH=/data
EXPOSE 8080

# Secrets and config are passed at runtime via -e flags or Cloud Run env vars:
#   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (web OAuth)
#   SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET
#   AR_SESSION_SECRET, AR_ADMIN_GROUP, AR_ALLOWED_DOMAINS, AR_AUDIENCE
#   GCP_PROJECT, GCP_REGION, AR_RUNTIME_ACCOUNT, GCP_VPC_CONNECTOR
# See secrets.example.jsonc for the full list.

CMD ["deno", "run", "-A", "--unstable-ffi", "control-plane/src/mod.ts"]
