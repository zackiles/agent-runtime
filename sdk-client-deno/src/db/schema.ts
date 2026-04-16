import type { Database } from '@db/sqlite'
import { TOOLS } from '../defaults/tools.ts'

const SCHEMA_VERSION = 8

const MIGRATIONS: string[] = [
  `
CREATE TABLE IF NOT EXISTS tenant (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  registry_protected INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS department (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES user(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, name)
);

CREATE TABLE IF NOT EXISTS team (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  department_id TEXT NOT NULL REFERENCES department(id),
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES user(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, name)
);

CREATE TABLE IF NOT EXISTS agent (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  team_id TEXT NOT NULL REFERENCES team(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '0.0.1',
  active_version TEXT,
  subsystem TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  created_by TEXT NOT NULL REFERENCES user(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, slug, version)
);

CREATE TABLE IF NOT EXISTS agent_owner (
  agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  PRIMARY KEY (agent_id, owner_id)
);

CREATE TABLE IF NOT EXISTS agent_edge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agent(id),
  direction TEXT NOT NULL,
  ref_type TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhook_config (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  url TEXT,
  method TEXT DEFAULT 'POST',
  headers TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cron_config (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  schedule TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Toronto',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS event_config (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  topic TEXT NOT NULL,
  filter TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS file_config (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  agent_id TEXT NOT NULL REFERENCES agent(id),
  path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tool (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '0.0.1',
  visibility TEXT NOT NULL DEFAULT 'private',
  owner_id TEXT NOT NULL REFERENCES user(id),
  config TEXT,
  gcs_path TEXT,
  has_install INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, slug, version)
);

CREATE TABLE IF NOT EXISTS skill (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  owner_id TEXT NOT NULL REFERENCES user(id),
  config TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, slug)
);

CREATE TABLE IF NOT EXISTS rule (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  owner_id TEXT NOT NULL REFERENCES user(id),
  config TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, slug)
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);
INSERT INTO schema_version (version) VALUES (1);
`,
  `
CREATE TABLE IF NOT EXISTS telemetry (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  trace_id TEXT,
  span_id TEXT,
  parent_span_id TEXT,
  timestamp INTEGER NOT NULL,
  client TEXT NOT NULL,
  client_version TEXT,
  fingerprint TEXT,
  actor TEXT,
  session TEXT,
  action TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  context TEXT,
  payload TEXT,
  environment TEXT,
  tags TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_telemetry_tenant
  ON telemetry(tenant_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_trace
  ON telemetry(trace_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_actor
  ON telemetry(tenant_id, actor);
CREATE INDEX IF NOT EXISTS idx_telemetry_action
  ON telemetry(tenant_id, action);
CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp
  ON telemetry(tenant_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_telemetry_session
  ON telemetry(tenant_id, session);
`,
  `
CREATE TABLE IF NOT EXISTS entity_owner (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entity_type, entity_id, owner_id)
);
`,
  `
ALTER TABLE skill ADD COLUMN version TEXT NOT NULL DEFAULT '0.0.1';
ALTER TABLE skill ADD COLUMN gcs_path TEXT;

ALTER TABLE rule ADD COLUMN version TEXT NOT NULL DEFAULT '0.0.1';
ALTER TABLE rule ADD COLUMN gcs_path TEXT;
`,
  `
ALTER TABLE agent ADD COLUMN template INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tool ADD COLUMN template INTEGER NOT NULL DEFAULT 0;
ALTER TABLE skill ADD COLUMN template INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rule ADD COLUMN template INTEGER NOT NULL DEFAULT 0;
`,
  `
ALTER TABLE agent ADD COLUMN source_type TEXT;
ALTER TABLE agent ADD COLUMN prompt TEXT;
`,
  `
CREATE TABLE IF NOT EXISTS slack_identity (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  user_id TEXT NOT NULL REFERENCES user(id),
  workspace_sub TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  slack_team_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, slack_user_id),
  UNIQUE(tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_slack_identity_user
  ON slack_identity(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_slack_identity_slack
  ON slack_identity(tenant_id, slack_user_id);

CREATE TABLE IF NOT EXISTS slack_settings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  user_id TEXT NOT NULL REFERENCES user(id),
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS slack_message (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  user_id TEXT NOT NULL REFERENCES user(id),
  slack_channel_id TEXT NOT NULL,
  slack_thread_ts TEXT,
  direction TEXT NOT NULL,
  command TEXT,
  content TEXT,
  agent_id TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_slack_message_user
  ON slack_message(tenant_id, user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_slack_message_agent
  ON slack_message(tenant_id, agent_id);

CREATE TABLE IF NOT EXISTS slack_agent_ref (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  user_id TEXT NOT NULL REFERENCES user(id),
  agent_id TEXT NOT NULL REFERENCES agent(id),
  cleanup_unused INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, user_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_slack_agent_ref_user
  ON slack_agent_ref(tenant_id, user_id);
`,
  `
ALTER TABLE agent ADD COLUMN uri TEXT;
`,
  `
CREATE TABLE IF NOT EXISTS skill_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '0.0.1',
  active_version TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  owner_id TEXT NOT NULL REFERENCES user(id),
  config TEXT,
  content TEXT,
  gcs_path TEXT,
  template INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, slug, version)
);
INSERT INTO skill_new
  (id, tenant_id, name, slug, version, active_version,
   visibility, owner_id, config, content, gcs_path,
   template, created_at)
SELECT id, tenant_id, name, slug, version, version,
       visibility, owner_id, config, NULL, gcs_path,
       template, created_at
FROM skill;
DROP TABLE skill;
ALTER TABLE skill_new RENAME TO skill;

CREATE TABLE IF NOT EXISTS rule_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenant(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '0.0.1',
  active_version TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  owner_id TEXT NOT NULL REFERENCES user(id),
  config TEXT,
  content TEXT,
  gcs_path TEXT,
  template INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, slug, version)
);
INSERT INTO rule_new
  (id, tenant_id, name, slug, version, active_version,
   visibility, owner_id, config, content, gcs_path,
   template, created_at)
SELECT id, tenant_id, name, slug, version, version,
       visibility, owner_id, config, NULL, gcs_path,
       template, created_at
FROM rule;
DROP TABLE rule;
ALTER TABLE rule_new RENAME TO rule;
`,
]

function ensureTenant(
  db: Database,
  tenantId: string,
  userEmail: string,
): void {
  const exists = db.prepare(
    'SELECT id FROM tenant WHERE id = ?',
  ).get(tenantId)
  if (!exists) {
    db.exec(
      'INSERT INTO tenant (id, name, registry_protected, created_by) VALUES (?, ?, 0, ?)',
      tenantId,
      tenantId,
      userEmail,
    )
  }
}

function seed(db: Database, tenantId: string, userEmail: string): void {
  const userExists = db.prepare(
    'SELECT id FROM user WHERE id = ?',
  ).get(userEmail)
  if (!userExists) {
    db.exec(
      'INSERT INTO user (id, name, is_admin) VALUES (?, ?, 1)',
      userEmail,
      userEmail,
    )
  }

  ensureTenant(db, tenantId, userEmail)

  const deptId = `default-department-${tenantId}`
  const deptExists = db.prepare(
    'SELECT id FROM department WHERE id = ?',
  ).get(deptId)
  if (!deptExists) {
    db.exec(
      `INSERT INTO department (id, tenant_id, name, owner_id)
       VALUES (?, ?, 'Default Department', ?)`,
      deptId,
      tenantId,
      userEmail,
    )
  }

  const teamId = `default-team-${tenantId}`
  const teamExists = db.prepare(
    'SELECT id FROM team WHERE id = ?',
  ).get(teamId)
  if (!teamExists) {
    db.exec(
      `INSERT INTO team (id, tenant_id, department_id, name, owner_id)
       VALUES (?, ?, ?, 'Default Team', ?)`,
      teamId,
      tenantId,
      deptId,
      userEmail,
    )
  }

  for (const tool of TOOLS()) {
    const toolExists = db.prepare(
      'SELECT id FROM tool WHERE tenant_id = ? AND slug = ?',
    ).get(tenantId, tool.slug)
    if (!toolExists) {
      const config = JSON.stringify({
        flags: tool.flags,
        env: tool.env,
      })
      db.exec(
        `INSERT INTO tool
         (id, tenant_id, name, slug, version, visibility,
          owner_id, config)
         VALUES (?, ?, ?, ?, ?, 'public', ?, ?)`,
        crypto.randomUUID(),
        tenantId,
        tool.name,
        tool.slug,
        tool.version,
        userEmail,
        config,
      )
    }
  }
}

function migrate(db: Database): void {
  const hasTable = db.prepare(
    `SELECT name FROM sqlite_master
     WHERE type='table' AND name='schema_version'`,
  ).get()

  if (!hasTable) {
    for (const sql of MIGRATIONS) {
      db.exec(sql)
    }
    db.exec(
      'UPDATE schema_version SET version = ?',
      MIGRATIONS.length,
    )
    return
  }

  const row = db.prepare(
    'SELECT version FROM schema_version LIMIT 1',
  ).get() as { version: number } | undefined
  const current = row?.version ?? 0

  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i])
    db.exec('UPDATE schema_version SET version = ?', i + 1)
  }
}

export { ensureTenant, migrate, SCHEMA_VERSION, seed }
