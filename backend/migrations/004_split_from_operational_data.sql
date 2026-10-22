-- 004: operational data (users, devices, ...) moved to MongoDB. The knowledge base and chat tables stay in
-- PostgreSQL but can no longer point at tables that live in another database, so those foreign keys are dropped.
-- The ids are unchanged (UUIDs); the application checks that an owner or device still exists.
-- The old operational tables (users, devices, telemetry, alerts, ...) are left untouched as a backup until you
-- remove them yourself - see docs/DEPLOYMENT_GUIDE.md ("Moving an existing installation to MongoDB").
ALTER TABLE kb_documents DROP CONSTRAINT IF EXISTS kb_documents_owner_id_fkey;
ALTER TABLE chat_conversations DROP CONSTRAINT IF EXISTS chat_conversations_user_id_fkey;
ALTER TABLE chat_conversations DROP CONSTRAINT IF EXISTS chat_conversations_device_id_fkey;
