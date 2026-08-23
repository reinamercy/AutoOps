-- ============================================================================
-- AutoOps AI — Fix ID Column Types
-- Migration: 005_fix_id_columns.sql
-- Description: stored_fixes.id (and the columns that reference it) were typed
--              UUID in 003_enterprise_upgrade.sql, but memory.service.ts has
--              always generated IDs like "fix-8c348115" (not valid UUID
--              syntax). This went unnoticed while database.ts was in-memory
--              only (it accepted any string as a key); real PostgreSQL
--              rejects the insert. Widen the columns to VARCHAR to match what
--              the application actually generates.
-- ============================================================================

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_fix_id_fkey;

ALTER TABLE stored_fixes ALTER COLUMN id DROP DEFAULT;
ALTER TABLE stored_fixes ALTER COLUMN id TYPE VARCHAR(64) USING id::text;

ALTER TABLE approvals ALTER COLUMN fix_id TYPE VARCHAR(64) USING fix_id::text;
ALTER TABLE risk_assessments ALTER COLUMN fix_id TYPE VARCHAR(64) USING fix_id::text;
ALTER TABLE decision_audit ALTER COLUMN fix_id TYPE VARCHAR(64) USING fix_id::text;

ALTER TABLE approvals
    ADD CONSTRAINT approvals_fix_id_fkey FOREIGN KEY (fix_id) REFERENCES stored_fixes(id);
