CREATE TYPE "public"."event_category" AS ENUM('body', 'mind', 'clinical', 'media', 'life', 'system');--> statement-breakpoint
CREATE TYPE "public"."event_significance" AS ENUM('primary', 'detail');--> statement-breakpoint
CREATE TYPE "public"."event_source" AS ENUM('user', 'device_import', 'derivation', 'document_extraction', 'model_inference', 'system');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'uploading', 'uploaded', 'failed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."task_kind" AS ENUM('thumbnail.generate', 'embedding.generate', 'document.extract-text', 'timeline.reproject', 'notification.send', 'ai.summarise');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'dead');--> statement-breakpoint
CREATE TABLE "app_metric" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"value" numeric(20, 6) NOT NULL,
	"route" text,
	"event_type" text,
	"step_name" text,
	"outcome" text,
	"device_class" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deferred_task" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" "task_kind" NOT NULL,
	"status" "task_status" DEFAULT 'pending' NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"not_before" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_error_code" text,
	"causation_event_id" uuid
);
--> statement-breakpoint
CREATE TABLE "domain_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sequence" bigserial NOT NULL,
	"event_type" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" text NOT NULL,
	"source" "event_source" NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"correlation_id" uuid NOT NULL,
	"causation_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "domain_event_version_positive" CHECK ("domain_event"."version" >= 1),
	CONSTRAINT "domain_event_no_self_causation" CHECK ("domain_event"."causation_id" IS NULL OR "domain_event"."causation_id" <> "domain_event"."id"),
	CONSTRAINT "domain_event_capture_after_occurrence" CHECK ("domain_event"."captured_at" >= "domain_event"."occurred_at" - interval '1 day')
);
--> statement-breakpoint
CREATE TABLE "event_dead_letter" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"handler_name" text NOT NULL,
	"attempts" integer NOT NULL,
	"error_code" text NOT NULL,
	"error_message" text NOT NULL,
	"failed_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution_note" text
);
--> statement-breakpoint
CREATE TABLE "event_handled" (
	"event_id" uuid NOT NULL,
	"handler_name" text NOT NULL,
	"handled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_thumbnail" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"media_object_id" uuid NOT NULL,
	"long_edge" integer NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" bigint,
	"wrapped_key" text
);
--> statement-breakpoint
CREATE TABLE "timeline_entry" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"sequence" bigint NOT NULL,
	"event_type" text NOT NULL,
	"category" "event_category" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"zone" text,
	"occurred_on" text NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"significance" "event_significance" NOT NULL,
	"clinical" boolean DEFAULT false NOT NULL,
	"correlation_id" uuid NOT NULL,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"has_media" boolean DEFAULT false NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(detail, ''))) STORED,
	"projected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"idempotency_key" text NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"media_object_id" uuid,
	"storage_key" text NOT NULL,
	"tier" text NOT NULL,
	"content_type" text NOT NULL,
	"expected_byte_size" bigint,
	"expected_content_hash" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error_code" text,
	"device_id" text,
	"progress" numeric(20, 6),
	"abandoned_reason" text
);
--> statement-breakpoint
ALTER TABLE "deferred_task" ADD CONSTRAINT "deferred_task_causation_event_id_domain_event_id_fk" FOREIGN KEY ("causation_event_id") REFERENCES "public"."domain_event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_dead_letter" ADD CONSTRAINT "event_dead_letter_event_id_domain_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."domain_event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_handled" ADD CONSTRAINT "event_handled_event_id_domain_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."domain_event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_thumbnail" ADD CONSTRAINT "media_thumbnail_media_object_id_media_object_id_fk" FOREIGN KEY ("media_object_id") REFERENCES "public"."media_object"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_entry" ADD CONSTRAINT "timeline_entry_event_id_domain_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."domain_event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_outbox" ADD CONSTRAINT "upload_outbox_media_object_id_media_object_id_fk" FOREIGN KEY ("media_object_id") REFERENCES "public"."media_object"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_metric_name_idx" ON "app_metric" USING btree ("name","recorded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "app_metric_recent_idx" ON "app_metric" USING btree ("recorded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "deferred_task_due_idx" ON "deferred_task" USING btree ("not_before","created_at") WHERE "deferred_task"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "deferred_task_pending_unique" ON "deferred_task" USING btree ("kind","subject_type","subject_id") WHERE "deferred_task"."status" IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX "deferred_task_dead_idx" ON "deferred_task" USING btree ("last_attempt_at" DESC NULLS LAST) WHERE "deferred_task"."status" = 'dead';--> statement-breakpoint
CREATE UNIQUE INDEX "domain_event_sequence_unique" ON "domain_event" USING btree ("sequence");--> statement-breakpoint
CREATE INDEX "domain_event_occurred_idx" ON "domain_event" USING btree ("occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "domain_event_type_idx" ON "domain_event" USING btree ("event_type","sequence");--> statement-breakpoint
CREATE INDEX "domain_event_subject_idx" ON "domain_event" USING btree ("subject_type","subject_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "domain_event_correlation_idx" ON "domain_event" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "domain_event_causation_idx" ON "domain_event" USING btree ("causation_id") WHERE "domain_event"."causation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "event_dead_letter_unique" ON "event_dead_letter" USING btree ("event_id","handler_name") WHERE "event_dead_letter"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "event_dead_letter_open_idx" ON "event_dead_letter" USING btree ("failed_at" DESC NULLS LAST) WHERE "event_dead_letter"."resolved_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "event_handled_pk" ON "event_handled" USING btree ("event_id","handler_name");--> statement-breakpoint
CREATE UNIQUE INDEX "media_thumbnail_unique" ON "media_thumbnail" USING btree ("media_object_id","long_edge");--> statement-breakpoint
CREATE UNIQUE INDEX "media_thumbnail_key_unique" ON "media_thumbnail" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "timeline_primary_idx" ON "timeline_entry" USING btree ("sequence" DESC NULLS LAST) WHERE "timeline_entry"."significance" = 'primary';--> statement-breakpoint
CREATE INDEX "timeline_sequence_idx" ON "timeline_entry" USING btree ("sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "timeline_occurred_on_idx" ON "timeline_entry" USING btree ("occurred_on");--> statement-breakpoint
CREATE INDEX "timeline_occurred_at_idx" ON "timeline_entry" USING btree ("occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "timeline_category_idx" ON "timeline_entry" USING btree ("category","sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "timeline_correlation_idx" ON "timeline_entry" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "timeline_media_idx" ON "timeline_entry" USING btree ("sequence" DESC NULLS LAST) WHERE "timeline_entry"."has_media" IS TRUE;--> statement-breakpoint
CREATE INDEX "timeline_clinical_idx" ON "timeline_entry" USING btree ("sequence" DESC NULLS LAST) WHERE "timeline_entry"."clinical" IS TRUE;--> statement-breakpoint
CREATE INDEX "timeline_search_idx" ON "timeline_entry" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX "upload_outbox_idempotency_unique" ON "upload_outbox" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "upload_outbox_pending_idx" ON "upload_outbox" USING btree ("created_at") WHERE "upload_outbox"."status" IN ('pending', 'uploading');--> statement-breakpoint
CREATE INDEX "upload_outbox_age_idx" ON "upload_outbox" USING btree ("created_at") WHERE "upload_outbox"."status" <> 'uploaded' AND "upload_outbox"."abandoned_reason" IS NULL;--> statement-breakpoint
CREATE INDEX "upload_outbox_media_idx" ON "upload_outbox" USING btree ("media_object_id");