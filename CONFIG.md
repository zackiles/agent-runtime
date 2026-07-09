# Configuration

All CLI settings can be provided via settings files, environment variables, or
CLI flags. Sources are loaded in order of precedence (lowest to highest):

1. **Defaults** from `default-settings.jsonc`
2. **Settings file** in the default location (`~/.ar/settings.jsonc` for
   production builds, `./settings.jsonc` when running from source)
3. **Environment variables** with `AR_` prefix
4. **`--settings <path>`** flag pointing to a JSONC file
5. **CLI flags** (highest precedence)

## Quick Start

### ClickOps (Manual Setup)

1. Create a GCP project and enable the required APIs:
   - Cloud Run, Cloud Functions, Cloud Build, Secret Manager, Cloud Scheduler
2. Create two service accounts:
   - `agent-runtime-sp@<project>.iam.gserviceaccount.com` (admin) with roles:
     Cloud Functions Developer, Cloud Run Admin, Run Invoker, Secret Manager
     Admin, Storage Admin, Cloud Scheduler Admin, Service Account User
   - `agent-worker-sp@<project>.iam.gserviceaccount.com` (worker) with roles:
     Run Invoker, Logging Log Writer
3. (Optional) Create a VPC connector if agents need private network access
4. Install the CLI and authenticate:

```bash
curl -fsSL https://raw.githubusercontent.com/zackiles/agent-runtime/main/install.sh | sh
gcloud auth login
```

5. Run the guided setup:

```bash
ar quickstart
```

Or initialize manually:

```bash
ar init --project my-project --region us-central1 \
  --runtime-account agent-runtime-sp@my-project.iam.gserviceaccount.com
```

### Pulumi (Infrastructure as Code)

> TBD — Pulumi templates for provisioning the GCP project, service account, VPC
> connector, and required APIs will be provided in a future release.

## Global Settings

Settings apply to all commands. They can appear in settings files, as
environment variables, or as CLI flags.

| Setting           | Env Variable           | Flag                  | Default                           | Description                   |
| ----------------- | ---------------------- | --------------------- | --------------------------------- | ----------------------------- |
| `project`         | `AR_PROJECT`           | `--project`           | —                                 | GCP project ID                |
| `region`          | `AR_REGION`            | `--region`            | `northamerica-northeast1`         | GCP region                    |
| `runtimeAccount`  | `AR_RUNTIME_ACCOUNT`   | `--runtime-account`   | `agent-runtime-sp@<project>...`   | Runtime account email         |
| `workerAccount`   | `AR_WORKER_ACCOUNT`    | `--worker-account`    | `agent-worker-sp@<project>...`    | Worker service account email  |
| `vpcConnector`    | `AR_VPC_CONNECTOR`     | `--vpc-connector`     | —                                 | VPC connector name (optional) |
| `runtime`         | `AR_RUNTIME`           | `--runtime`           | `nodejs22`                        | Cloud Functions runtime       |
| `tenant`          | `AR_TENANT`            | `--tenant`            | `development`                     | Target tenant                 |
| `registry`        | `AR_REGISTRY`          | `--registry`          | `~/.ar/registry/`                 | Registry folder path          |
| `agentDeployMode` | `AR_AGENT_DEPLOY_MODE` | `--agent-deploy-mode` | `container`                       | Agent deploy mode             |
| `auth.method`     | `AR_AUTH_METHOD`       | `--auth.method`       | `user` (interactive) / `adc` (CI) | Authentication method         |

## Authentication

Two authentication methods are supported:

### User Login (default in interactive mode)

Uses `gcloud auth login` for interactive authentication. This is the default
when running in a terminal.

```bash
gcloud auth login
ar deploy my-agent
```

### Application Default Credentials (default in CI)

Uses ADC for non-interactive authentication. This works with:

- `GOOGLE_APPLICATION_CREDENTIALS` pointing to a service account key
- GCE/Cloud Run metadata server (automatic on GCP)
- Workload Identity Federation (GitHub Actions OIDC)

```bash
ar deploy my-agent --no-input --auth.method adc
```

Or via environment variable:

```bash
export AR_AUTH_METHOD=adc
ar deploy my-agent --no-input
```

When `--no-input` is used without an explicit auth method, `adc` is selected
automatically.

### GitHub Actions (OIDC / Workload Identity Federation)

The recommended approach for CI is to use GitHub OIDC with Workload Identity
Federation. This avoids storing any credentials as secrets.

**GCP Setup:**

1. Create a Workload Identity Pool:

```bash
gcloud iam workload-identity-pools create github-pool \
  --location=global \
  --display-name="GitHub Actions"
```

2. Create a Provider for your GitHub repo:

```bash
gcloud iam workload-identity-pools providers create-oidc github-provider \
  --location=global \
  --workload-identity-pool=github-pool \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository"
```

3. Grant the service account access:

```bash
gcloud iam service-accounts add-iam-policy-binding \
  agent-runtime-sp@PROJECT.iam.gserviceaccount.com \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-pool/attribute.repository/OWNER/REPO"
```

**GitHub Repository Variables:**

| Variable              | Value                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `WIF_PROVIDER`        | `projects/<number>/locations/global/workloadIdentityPools/github-pool/providers/github-provider` |
| `WIF_SERVICE_ACCOUNT` | `agent-runtime-sp@<project>.iam.gserviceaccount.com`                                             |
| `GCP_PROJECT`         | Your GCP project ID                                                                              |
| `GCP_REGION`          | Your GCP region                                                                                  |
| `AR_RUNTIME_ACCOUNT`  | Same as `WIF_SERVICE_ACCOUNT`                                                                    |
| `AR_WORKER_ACCOUNT`   | `agent-worker-sp@<project>.iam.gserviceaccount.com`                                              |
| `GCP_VPC_CONNECTOR`   | (Optional) Your VPC connector name                                                               |

See `.github/workflows/ci.yml` for a working reference implementation.

## User Settings

GCP project-specific values (project, region, service account) can be provided
via environment variables (`AR_PROJECT`, `AR_REGION`, etc.), CLI flags
(`--project`, `--region`), or a local settings file passed with `--settings`.
The global runtime config lives in [`default-settings.jsonc`](default-settings.jsonc)
and is checked into the repo — do not put project-specific values there.

## Non-Interactive Mode

Use `--no-input` to disable all interactive prompts. Required values must be
provided via settings files, environment variables, or CLI flags. If a required
value is missing, the CLI will error with a message indicating which flag to
provide.

```bash
ar init --no-input --project my-project --region us-central1 \
  --runtime-account agent-runtime-sp@my-project.iam.gserviceaccount.com

ar cp deploy --no-input
ar cp destroy --no-input --force
```

Non-interactive mode is also activated automatically when stdin is not a TTY
(e.g. in CI pipelines).

## Demo Builder

The demo builder feature allows users to create fullstack demo applications from
natural language prompts. The `POST /api/demos` endpoint invokes the
`demo-agent` Cloud Function, which uses the Cursor subsystem to generate code,
pushes files to GCS, and optionally triggers a Cloud Run deploy. The
`demo-agent` must be deployed first (`ar agent deploy demo-agent`).

### Prerequisites

The following GCP APIs must be enabled for demo container deployment:

- **Cloud Run Admin API** (`run.googleapis.com`) — for deploying demo containers
- **IAM API** (`iam.googleapis.com`) — for setting IAM policies on demo services

The `agent-runtime-sp` service account must have:

| Role                           | Purpose                                            |
| ------------------------------ | -------------------------------------------------- |
| `roles/run.admin`              | Create, update, and delete demo Cloud Run services |
| `roles/iam.serviceAccountUser` | Act as the service account for demo services       |
| `roles/storage.admin`          | Read/write demo source and metadata in GCS         |

### Demo Container Isolation

Each demo runs as an isolated Cloud Run service with:

- **No VPC access** — demos cannot reach other services in the project
- **No GCS access** — the worker service account has no storage permissions
- **Authenticated by default** — demos are restricted to `allAuthenticatedUsers`
  (any Google-authenticated user). The demo agent can override this to `allUsers`
  (public) when the user's prompt explicitly requests public access.
- **Manual override** — the `POST /api/demos/:name/deploy` endpoint accepts an
  optional `visibility` body field (`"public"` or `"private"`) for manual control.
- **Auto-expiry** — containers are destroyed after 7 days by default
  (configurable via the cleanup endpoint)

### Demo Storage Layout

Demos are stored in the registry GCS bucket under:

```
{tenantId}/demos/{userId}/{demoSlug}/
  demo.json          # Metadata (name, url, prompt, summary, timestamps)
  source/            # Full demo source code
```

### API Endpoints

| Method   | Path                        | Description                       |
| -------- | --------------------------- | --------------------------------- |
| `POST`   | `/api/demos`                | Create a new demo from prompt     |
| `GET`    | `/api/demos`                | List demos for the current user   |
| `GET`    | `/api/demos/:name`          | Get demo metadata                 |
| `POST`   | `/api/demos/:name/deploy`   | Deploy demo to Cloud Run          |
| `POST`   | `/api/demos/:name/stop`     | Stop the Cloud Run service        |
| `POST`   | `/api/demos/:name/update`   | Update demo with feedback         |
| `GET`    | `/api/demos/:name/download` | Download demo source files        |
| `DELETE` | `/api/demos/:name`          | Delete demo and its container     |
| `POST`   | `/api/demos/cleanup`        | Admin: expire old demo containers |

## Access Agent

The access agent helps users configure access to apps, resources, data sources,
and third-party services. It uses a two-turn flow: first building a custom UI to
collect credentials, then processing the collected data to store secrets.

### Prerequisites

The following GCP APIs must be enabled:

- **Secret Manager API** (`secretmanager.googleapis.com`) — for storing
  credentials collected during access setup
- **Cloud Run Admin API** (`run.googleapis.com`) — for deploying one-time-use
  access UIs via the Demo Agent

The `agent-runtime-sp` service account must have:

| Role                           | Purpose                         |
| ------------------------------ | ------------------------------- |
| `roles/secretmanager.admin`    | Create secrets and add versions |
| `roles/run.admin`              | Deploy access UI containers     |
| `roles/iam.serviceAccountUser` | Act as the service account      |

### Scope and Permissions

| Scope     | Visibility                           | Who Can Configure      |
| --------- | ------------------------------------ | ---------------------- |
| `private` | Current user's private registry only | Any authenticated user |
| `public`  | All users and agents in the tenant   | Admins only            |

Private secrets are namespaced with the pattern `access-{resource}-{key}` and
stored in GCP Secret Manager. They are only accessible to the user who created
them and their private agents.

Public secrets follow the same naming pattern but are accessible to all users
and agents in the tenant. Only admins can create public access grants.

### Guided Setup Flow

1. **Request** — User selects a resource (or describes a custom one) and scope
2. **UI Generation** — The access agent invokes the Demo Agent to build a
   one-time-use web UI tailored to the access type (OAuth, API key, file upload,
   multi-step wizard)
3. **Credential Collection** — User completes the UI, which encodes all
   collected data into a base64 context string
4. **Callback** — User pastes the context string back into the Access page
5. **Configuration** — Secrets are stored and runtime is configured

### API Endpoints

| Method   | Path                   | Description                         |
| -------- | ---------------------- | ----------------------------------- |
| `POST`   | `/api/access`          | Initiate access request             |
| `POST`   | `/api/access/callback` | Complete setup with context string  |
| `GET`    | `/api/access`          | List access grants for current user |
| `GET`    | `/api/access/:id`      | Get specific access grant           |
| `DELETE` | `/api/access/:id`      | Remove access grant                 |

### Storage Layout

Access grants are stored in the registry GCS bucket:

```
{tenantId}/access/{userId}/{grantId}/
  grant.json         # Grant metadata (resource, scope, status, secrets)
```

## Security Model

### Service Accounts

The runtime uses two GCP service accounts to enforce least-privilege:

| Account                | Default Name       | Purpose                                       |
| ---------------------- | ------------------ | --------------------------------------------- |
| **Admin (runtime) SA** | `agent-runtime-sp` | CLI and control plane provisioning            |
| **Worker SA**          | `agent-worker-sp`  | Runtime identity for deployed agent functions |

The admin SA has broad project-level roles needed for deploying functions,
managing secrets, creating Cloud Run services, pushing container images, and
submitting Cloud Builds. The worker SA has `roles/run.invoker`,
`roles/logging.logWriter`, `roles/artifactregistry.reader` (to pull images),
`roles/storage.objectViewer` (for GCS FUSE mounts), and
`roles/secretmanager.secretAccessor` (to read mounted secrets at runtime).

In **container mode**, agent secrets from Secret Manager are mounted directly
as environment variables on the Cloud Run service. In **source mode**, secret
access is granted per-secret via `secretGrantAccess`.

### Control Plane Authentication

The control plane is deployed with `--allow-unauthenticated` on Cloud Run.
Cloud Run's IAM invoker check is bypassed intentionally — authentication is
handled at the application layer via JWT verification middleware. This is
required for the OAuth callback flow, Slack webhook endpoints, and the web
login page, which must be reachable without a pre-existing credential.

All API and web routes verify Google-issued JWTs (ID tokens) with signature
validation against Google's JWKS endpoint. When `AR_AUDIENCE` is set (done
automatically during `ar cp deploy`), the audience claim is validated against
two allowed values: the control plane URL itself (for service account tokens)
and the gcloud CLI's OAuth client ID (for user tokens from
`gcloud auth print-identity-token`). This allows both CI/automation and local
developer access without custom audience configuration.

Domain restrictions can be applied via `AR_ALLOWED_DOMAINS`.

### Telemetry Ingest Authentication

Posting telemetry (`POST /telemetry`) is gated by a **telemetry API key**
(`X-Telemetry-Key` header), not a Google identity. Admins mint per-client keys
on the telemetry page; reading telemetry and managing clients remain behind
admin identity. See [docs/telemetry.md](docs/telemetry.md) for the full design.

`AR_TELEMETRY_KEY_PEPPER` is an **optional** server-side secret mixed into the
SHA-256 hash of every telemetry key before it is stored. Keys are never stored
in plaintext; the pepper adds defense in depth so that a leaked database cannot
be brute-forced into usable keys even with a weak random source. It is optional
— if unset, keys are hashed without a pepper and the feature works normally.

> **Setting or changing the pepper after keys exist invalidates every existing
> key** (their stored hashes no longer match). Treat pepper rotation as a
> deliberate fleet-wide revocation that must be coordinated with re-issuing keys.

It is wired through the standard secrets mapping in `default-settings.jsonc`
(`ar-telemetry-key-pepper` → `AR_TELEMETRY_KEY_PEPPER`), so the deploy pipeline
injects it as an env var with no extra Cloud Run wiring.

### Agent Function Environment

When a control plane URL is configured (i.e. after `ar cp deploy`), agent
deploy (`ar agent deploy`) automatically sets these environment variables on
the Cloud Function:

| Variable               | Value                        | Purpose                        |
| ---------------------- | ---------------------------- | ------------------------------ |
| `AR_CONTROL_PLANE_URL` | Control plane Cloud Run URL  | Storage and deploy callbacks   |
| `AR_BUCKET`            | `{project}-ar-registry`      | GCS bucket for agent storage   |
| `AR_TENANT_ID`         | Default tenant from settings | Tenant scope for storage paths |

Agent functions obtain identity tokens from the GCP metadata server at
invocation time to authenticate against the control plane. No static
`AR_TOKEN` needs to be configured.

### Secret Rotation

Running `ar secret set <name> <value>` updates the secret in GCP Secret
Manager and automatically refreshes any deployed Cloud Functions that
reference it. This forces a new Cloud Run revision so the function picks up
the latest secret value without a manual redeploy.
