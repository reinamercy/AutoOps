-- ============================================================================
-- AutoOps AI — Incidents Migration
-- Migration: 004_incidents.sql
-- Description: Adds the incidents and incident_events tables. These backed
--              the in-memory Maps in services/database.ts prior to this
--              migration; now they persist for real when Postgres is reachable.
-- ============================================================================

CREATE TABLE IF NOT EXISTS incidents (
    id                      VARCHAR(64) PRIMARY KEY,
    created_at              TIMESTAMPTZ NOT NULL,
    resolved_at             TIMESTAMPTZ,
    severity                VARCHAR(20),
    root_cause_category     VARCHAR(100),
    root_cause_service      VARCHAR(255),
    root_cause_description  TEXT,
    root_cause_confidence   DECIMAL(4,3),
    plan_title              TEXT,
    plan_steps              JSONB,
    priority                VARCHAR(10),
    execution_status        VARCHAR(20),
    outcome                 VARCHAR(20),
    duration_seconds        INT,
    retry_count             INT DEFAULT 0,
    lessons_learned         TEXT[],
    full_state              JSONB,
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS incident_events (
    id            SERIAL PRIMARY KEY,
    incident_id   VARCHAR(64) NOT NULL,
    agent         VARCHAR(50) NOT NULL,
    event_type    VARCHAR(50) NOT NULL,
    data          JSONB,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incidents_created_at
    ON incidents(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_incident_events_incident
    ON incident_events(incident_id, created_at);
