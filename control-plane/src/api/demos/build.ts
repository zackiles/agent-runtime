const NODE_DOCKERFILE = `FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --production=false
COPY . .
RUN if [ -f tsconfig.json ]; then npx tsc; fi
RUN if npm run 2>/dev/null | grep -q "^  build$"; then npm run build; fi

FROM node:22-slim
WORKDIR /app
COPY --from=build /app .
RUN npm prune --production
ENV PORT=8000
EXPOSE 8000
CMD ["node", "ENTRYPOINT_PLACEHOLDER"]
`

const STATIC_DOCKERFILE = `FROM node:22-slim AS build
WORKDIR /app
COPY . .
RUN if [ -f package.json ]; then npm ci && npm run build 2>/dev/null || true; fi

FROM nginx:alpine
COPY --from=build /app/OUTPUT_DIR_PLACEHOLDER /usr/share/nginx/html
COPY <<'NGINX' /etc/nginx/conf.d/default.conf
server {
    listen 8000;
    location / {
        root /usr/share/nginx/html;
        try_files $uri $uri/ /index.html;
    }
}
NGINX
EXPOSE 8000
CMD ["nginx", "-g", "daemon off;"]
`

const DENO_DOCKERFILE = `FROM denoland/deno:latest
WORKDIR /app
COPY . .
RUN deno cache main.ts 2>/dev/null || deno cache mod.ts 2>/dev/null || true
ENV PORT=8000
EXPOSE 8000
CMD ["deno", "run", "--allow-all", "ENTRYPOINT_PLACEHOLDER"]
`

const VANILLA_NODE_DOCKERFILE = `FROM node:22-slim
WORKDIR /app
COPY . .
ENV PORT=8000
EXPOSE 8000
CMD ["node", "ENTRYPOINT_PLACEHOLDER"]
`

// IMPORTANT: Cloud Build interprets $VAR in step args as substitution
// variables. Use $$ to escape — Cloud Build renders $$ as a literal $.
// Every shell variable in these scripts must be double-dollared.

function detectScript(): string {
  return `cd /workspace
if [ -f ar-build.json ]; then
  cp ar-build.json build-config.json
else
  if [ -f Dockerfile ]; then
    echo '{"type":"custom"}' > build-config.json
  elif [ -f package.json ]; then
    if [ -f tsconfig.json ] || (cat package.json | grep -q '"build"'); then
      echo '{"type":"node","build":true}' > build-config.json
    elif [ -f server.js ]; then
      echo '{"type":"node","entrypoint":"server.js"}' > build-config.json
    else
      echo '{"type":"node","build":true}' > build-config.json
    fi
  elif [ -f deno.json ] || [ -f deno.jsonc ]; then
    echo '{"type":"deno"}' > build-config.json
  elif [ -f index.html ]; then
    echo '{"type":"static","outputDir":"."}' > build-config.json
  elif [ -f server.js ]; then
    echo '{"type":"node","entrypoint":"server.js"}' > build-config.json
  else
    echo '{"type":"unknown"}' > build-config.json
  fi
fi
cat build-config.json
`
}

function generateDockerfileScript(): string {
  const D = '$$'
  return [
    'cd /workspace',
    'if [ -f Dockerfile ]; then',
    '  echo "Using existing Dockerfile"',
    '  exit 0',
    'fi',
    '',
    `CONFIG=${D}(cat build-config.json)`,
    `TYPE=${D}(echo "${D}CONFIG" | grep -o '"type":"[^"]*"' | head -1 | cut -d'"' -f4)`,
    `ENTRYPOINT=${D}(echo "${D}CONFIG" | grep -o '"entrypoint":"[^"]*"' | head -1 | cut -d'"' -f4)`,
    `OUTPUT_DIR=${D}(echo "${D}CONFIG" | grep -o '"outputDir":"[^"]*"' | head -1 | cut -d'"' -f4)`,
    `HAS_BUILD=${D}(echo "${D}CONFIG" | grep -o '"build":true')`,
    '',
    `case "${D}TYPE" in`,
    '  custom)',
    '    echo "Custom Dockerfile already present"',
    '    ;;',
    '  node)',
    `    ENTRY=${D}{ENTRYPOINT:-server.js}`,
    `    if [ -n "${D}HAS_BUILD" ] || [ -f tsconfig.json ]; then`,
    '      cat > Dockerfile <<DOCKERFILE',
    'FROM node:22-slim AS build',
    'WORKDIR /app',
    'COPY package*.json ./',
    'RUN npm ci --production=false',
    'COPY . .',
    'RUN if [ -f tsconfig.json ]; then npx tsc; fi',
    `RUN if npm run 2>/dev/null | grep -q "^  build${D}"; then npm run build; fi`,
    '',
    'FROM node:22-slim',
    'WORKDIR /app',
    'COPY --from=build /app .',
    'RUN npm prune --production',
    'ENV PORT=8000',
    'EXPOSE 8000',
    `CMD ["node", "${D}ENTRY"]`,
    'DOCKERFILE',
    '    elif [ -f package.json ]; then',
    '      cat > Dockerfile <<DOCKERFILE',
    'FROM node:22-slim',
    'WORKDIR /app',
    'COPY package*.json ./',
    'RUN npm ci --production',
    'COPY . .',
    'ENV PORT=8000',
    'EXPOSE 8000',
    `CMD ["node", "${D}ENTRY"]`,
    'DOCKERFILE',
    '    else',
    '      cat > Dockerfile <<DOCKERFILE',
    'FROM node:22-slim',
    'WORKDIR /app',
    'COPY . .',
    'ENV PORT=8000',
    'EXPOSE 8000',
    `CMD ["node", "${D}ENTRY"]`,
    'DOCKERFILE',
    '    fi',
    '    ;;',
    '  static)',
    `    OUT=${D}{OUTPUT_DIR:-dist}`,
    `    if [ "${D}OUT" = "." ]; then`,
    '      SRC_DIR="/app"',
    '    else',
    `      SRC_DIR="/app/${D}OUT"`,
    '    fi',
    '    cat > Dockerfile <<DOCKERFILE',
    'FROM node:22-slim AS build',
    'WORKDIR /app',
    'COPY . .',
    'RUN if [ -f package.json ]; then npm ci && npm run build 2>/dev/null || true; fi',
    '',
    'FROM nginx:alpine',
    `COPY --from=build ${D}SRC_DIR /usr/share/nginx/html`,
    `RUN printf 'server {\\n    listen 8000;\\n    location / {\\n        root /usr/share/nginx/html;\\n        try_files \\${D}uri \\${D}uri/ /index.html;\\n    }\\n}\\n' > /etc/nginx/conf.d/default.conf`,
    'EXPOSE 8000',
    'CMD ["nginx", "-g", "daemon off;"]',
    'DOCKERFILE',
    '    ;;',
    '  deno)',
    `    ENTRY=${D}{ENTRYPOINT:-main.ts}`,
    '    cat > Dockerfile <<DOCKERFILE',
    'FROM denoland/deno:latest',
    'WORKDIR /app',
    'COPY . .',
    `RUN deno cache ${D}ENTRY 2>/dev/null || true`,
    'ENV PORT=8000',
    'EXPOSE 8000',
    `CMD ["deno", "run", "--allow-all", "${D}ENTRY"]`,
    'DOCKERFILE',
    '    ;;',
    '  *)',
    `    echo "ERROR: Unknown stack type '${D}TYPE'. Expected ar-build.json or recognizable project structure."`,
    '    echo "Found files:"',
    '    ls -la /workspace/',
    '    exit 1',
    '    ;;',
    'esac',
    '',
    `echo "Generated Dockerfile for type=${D}TYPE"`,
    'cat Dockerfile',
  ].join('\n')
}

export {
  DENO_DOCKERFILE,
  detectScript,
  generateDockerfileScript,
  NODE_DOCKERFILE,
  STATIC_DOCKERFILE,
  VANILLA_NODE_DOCKERFILE,
}
