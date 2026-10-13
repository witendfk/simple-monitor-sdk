-- Postgres 元数据域全量 DDL（M7.5 P1，ADR-4 落地设计见 docs/ARCHITECTURE.md §3.2）
-- 职责铁律：PG 只存可变状态与小量事务数据；事件事实归 ClickHouse（append-only）。
-- 幂等纪律：issue 的 first/last_seen 用 LEAST/GREATEST 幂等更新、event_count 由 CH 对账
-- 覆写——重试重放不会造成 PG 侧错计（CH 重复计数为已知边界，P4 稳定事件 ID 修复）。

CREATE TABLE IF NOT EXISTS users (
    id            BIGSERIAL PRIMARY KEY,
    account       TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name  TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
    id                BIGSERIAL PRIMARY KEY,
    -- 双密钥地基（P3 权限分离启用）：public_key 上报身份 / secret_key_hash 管理身份
    public_key        TEXT UNIQUE NOT NULL,
    secret_key_hash   TEXT,
    name              TEXT NOT NULL,
    rate_limit_per_min INTEGER NOT NULL DEFAULT 1000,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_members (
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    PRIMARY KEY (project_id, user_id)
);

-- Issue 状态机：M5「查询时聚合」的退出（first_seen/last_seen/event_count 持久化）
CREATE TABLE IF NOT EXISTS issues (
    id            BIGSERIAL PRIMARY KEY,
    project_id    BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    fingerprint   TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
    first_seen    TIMESTAMPTZ NOT NULL,
    last_seen     TIMESTAMPTZ NOT NULL,
    first_release TEXT,
    event_count   BIGINT NOT NULL DEFAULT 0,
    UNIQUE (project_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_issues_project_status ON issues (project_id, status, last_seen DESC);

CREATE TABLE IF NOT EXISTS alert_rules (
    id               TEXT PRIMARY KEY,
    project_id       BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type             TEXT NOT NULL CHECK (type IN ('error_spike', 'perf_threshold')),
    name             TEXT NOT NULL,
    webhook_url      TEXT NOT NULL,
    cooldown_minutes INTEGER NOT NULL DEFAULT 15,
    enabled          BOOLEAN NOT NULL DEFAULT TRUE,
    config           JSONB NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alert_history (
    id        BIGSERIAL PRIMARY KEY,
    rule_id   TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
    apikey    TEXT NOT NULL,
    fired_at  TIMESTAMPTZ NOT NULL,
    message   TEXT NOT NULL,
    context   JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alert_history_apikey ON alert_history (apikey, fired_at DESC);

CREATE TABLE IF NOT EXISTS releases (
    id         BIGSERIAL PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    release    TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, release)
);

CREATE TABLE IF NOT EXISTS sourcemap_artifacts (
    id          BIGSERIAL PRIMARY KEY,
    project_id  BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    release     TEXT NOT NULL,
    url         TEXT NOT NULL,
    map_json    TEXT NOT NULL,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, release, url)
);
