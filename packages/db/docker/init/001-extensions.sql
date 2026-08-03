-- Extensions required by blueprint §5.3 and §9.6.
--
-- This runs once, as superuser, when the container initialises an empty data
-- directory. It is deliberately NOT a Drizzle migration: CREATE EXTENSION
-- requires privileges the application role does not have in production, where
-- Supabase provisions extensions through its own dashboard. Keeping them out of
-- the migration directory means the committed migrations (§9.4: "forward-only,
-- never edited once applied") stay runnable by an unprivileged role.
--
-- Anything added here must also be enabled in the Supabase project, or a
-- migration that depends on it will pass locally and fail in production.

-- Semantic search over journal entries and documents (§10, §9.6 HNSW index).
CREATE EXTENSION IF NOT EXISTS vector;

-- Trigram matching for typo-tolerant exercise and food lookup (§9.6).
-- Without this the food library fails P1's ten-second rule the first time a
-- name is misspelt.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- gen_random_bytes and digest, used for content hashing in the audit trail.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- GiST support for scalar types, which is what makes the exclusion constraints
-- in §9.6 possible: "prevents two active schedules for the same medication".
-- A btree index cannot express that; a GiST exclusion constraint can.
CREATE EXTENSION IF NOT EXISTS btree_gist;
