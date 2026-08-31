CREATE TYPE "public"."calendar_source" AS ENUM('ics', 'google', 'manual');--> statement-breakpoint
CREATE TYPE "public"."career_entry_kind" AS ENUM('shipped', 'artifact', 'feedback', 'recognition', 'review', 'role_change', 'incident');--> statement-breakpoint
CREATE TYPE "public"."learning_kind" AS ENUM('book', 'paper', 'course', 'talk', 'article', 'other');--> statement-breakpoint
CREATE TYPE "public"."learning_status" AS ENUM('queued', 'in_progress', 'finished', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('active', 'shipped', 'paused', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."work_task_status" AS ENUM('open', 'done', 'dropped');--> statement-breakpoint
CREATE TABLE "calendar_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"source" "calendar_source" NOT NULL,
	"external_id" text,
	"calendar_name" text,
	"title" text,
	"location" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"zone" text NOT NULL,
	"is_all_day" boolean DEFAULT false NOT NULL,
	"attendee_count" integer,
	"is_accepted" boolean,
	"is_travel" boolean DEFAULT false NOT NULL,
	"last_imported_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "career_entry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"kind" "career_entry_kind" NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"zone" text,
	"project_id" uuid,
	"attributed_to" text,
	"artifact_url" text,
	"is_visible_to_leadership" boolean,
	"skills" text[],
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(detail, ''))) STORED
);
--> statement-breakpoint
CREATE TABLE "focus_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"zone" text NOT NULL,
	"day_key" text NOT NULL,
	"project_id" uuid,
	"task_id" uuid,
	"label" text,
	"quality" integer,
	"interruptions" integer,
	"note" text,
	CONSTRAINT "focus_session_ordered" CHECK ("focus_session"."ended_at" IS NULL OR "focus_session"."started_at" <= "focus_session"."ended_at"),
	CONSTRAINT "focus_session_quality_range" CHECK ("focus_session"."quality" IS NULL OR "focus_session"."quality" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "learning_item" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"kind" "learning_kind" NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"url" text,
	"status" "learning_status" DEFAULT 'queued' NOT NULL,
	"total_units" integer,
	"completed_units" integer,
	"unit_label" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"abandoned_reason" text,
	"synthesis" text,
	"skills" text[],
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(author, '') || ' ' || coalesce(synthesis, ''))) STORED,
	CONSTRAINT "learning_item_progress_bounded" CHECK ("learning_item"."completed_units" IS NULL OR "learning_item"."total_units" IS NULL OR "learning_item"."completed_units" <= "learning_item"."total_units")
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"name" text NOT NULL,
	"description" text,
	"status" "project_status" DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"context" text,
	"goal_id" uuid,
	CONSTRAINT "project_ordered" CHECK ("project"."ended_at" IS NULL OR "project"."started_at" IS NULL OR "project"."started_at" <= "project"."ended_at")
);
--> statement-breakpoint
CREATE TABLE "task" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"title" text NOT NULL,
	"note" text,
	"status" "work_task_status" DEFAULT 'open' NOT NULL,
	"project_id" uuid,
	"goal_id" uuid,
	"linked_entity_type" text,
	"linked_entity_id" uuid,
	"due_day_key" text,
	"completed_at" timestamp with time zone,
	"completed_day_key" text,
	"zone" text,
	"dropped_reason" text,
	CONSTRAINT "task_completed_together" CHECK (("task"."completed_at" IS NULL) = ("task"."completed_day_key" IS NULL)),
	CONSTRAINT "task_done_has_completion" CHECK ("task"."status" <> 'done' OR "task"."completed_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "career_entry" ADD CONSTRAINT "career_entry_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "focus_session" ADD CONSTRAINT "focus_session_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "focus_session" ADD CONSTRAINT "focus_session_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_event_starts_idx" ON "calendar_event" USING btree ("starts_at" DESC NULLS LAST) WHERE "calendar_event"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_event_external_unique" ON "calendar_event" USING btree ("source","external_id") WHERE "calendar_event"."external_id" IS NOT NULL AND "calendar_event"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "career_entry_occurred_idx" ON "career_entry" USING btree ("occurred_at" DESC NULLS LAST) WHERE "career_entry"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "career_entry_kind_idx" ON "career_entry" USING btree ("kind","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "career_entry_search_idx" ON "career_entry" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "focus_session_day_idx" ON "focus_session" USING btree ("day_key" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "focus_session_project_idx" ON "focus_session" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "learning_item_status_idx" ON "learning_item" USING btree ("status") WHERE "learning_item"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "learning_item_search_idx" ON "learning_item" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "project_status_idx" ON "project" USING btree ("status") WHERE "project"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "task_status_idx" ON "task" USING btree ("status","due_day_key") WHERE "task"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "task_project_idx" ON "task" USING btree ("project_id") WHERE "task"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "task_completed_idx" ON "task" USING btree ("completed_day_key" DESC NULLS LAST) WHERE "task"."completed_day_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "task_linked_idx" ON "task" USING btree ("linked_entity_type","linked_entity_id");--> statement-breakpoint

-- §5.4's RLS posture, extended to the six tables above.
--
-- Migration 0004 enabled RLS on every table that existed then, and 0007 did the
-- same for the event log. Neither can cover a table added afterwards, and
-- Postgres will not complain about one that is missing — `rls.test.ts` is what
-- actually holds this line, and it fails the moment a new table lands without
-- this block. Same posture as every time before: enabled, FORCEd, no policies,
-- so the PostgREST path reaches a database that returns nothing even holding the
-- anon key that ships in the browser bundle.
--
-- `career_entry` is the table that makes this worth restating. It is a
-- chronological record of the operator's professional life with named
-- attribution on the feedback rows — the one table here that would be damaging
-- to an employment relationship rather than merely private.
DO $$
DECLARE
  target regclass;
BEGIN
  FOR target IN
    SELECT c.oid::regclass
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND NOT c.relrowsecurity
       AND c.relname <> '__drizzle_migrations'
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  END LOOP;
END;
$$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
  END IF;
END;
$$;
