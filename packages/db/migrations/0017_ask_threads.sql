-- Saved lines of enquiry — §3.2's `/ask/:threadId`, which has had a route in the
-- table since day one and no table behind it.
--
-- Two tables, and what they deliberately cannot express is the design. There is
-- no conversation transcript and no column the context builder reads, because
-- feeding a model its own prior output makes it reason over its own assertions
-- rather than over the record — §10.0's prohibition, in the one place it is
-- most tempting to break.
--
-- A thread groups questions for the operator's continuity. Each question is
-- still answered from a freshly assembled context pack.

CREATE TABLE "ask_thread" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"title" text NOT NULL,
	"note" text,
	"last_asked_at" timestamp with time zone,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(note, ''))) STORED
);
--> statement-breakpoint
CREATE TABLE "ask_turn" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"thread_id" uuid NOT NULL,
	"question" text NOT NULL,
	"kind" text NOT NULL,
	"window_days" integer NOT NULL,
	"answer" jsonb,
	"omitted" text,
	"problem" text,
	"interaction_id" uuid,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(question, ''))) STORED,
	CONSTRAINT "ask_turn_outcome" CHECK (("ask_turn"."answer" IS NULL) <> ("ask_turn"."problem" IS NULL)),
	CONSTRAINT "ask_turn_window_positive" CHECK ("ask_turn"."window_days" > 0)
);
--> statement-breakpoint
ALTER TABLE "ask_turn" ADD CONSTRAINT "ask_turn_thread_id_ask_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."ask_thread"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ask_turn" ADD CONSTRAINT "ask_turn_interaction_id_ai_interaction_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."ai_interaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ask_thread_recent_idx" ON "ask_thread" USING btree ("last_asked_at" DESC NULLS LAST) WHERE "ask_thread"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ask_thread_search_idx" ON "ask_thread" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "ask_turn_thread_idx" ON "ask_turn" USING btree ("thread_id","asked_at" DESC NULLS LAST) WHERE "ask_turn"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ask_turn_search_idx" ON "ask_turn" USING gin ("search_vector");
--> statement-breakpoint

-- §5.4's RLS posture. Same block as every migration that has added a table:
-- enabled, FORCEd, no policies, so the PostgREST path returns nothing even if
-- the anon key leaks. `rls.test.ts` is the standing guarantee.
DO $$
DECLARE
  target regclass;
BEGIN
  FOR target IN
    SELECT c.oid::regclass
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
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
