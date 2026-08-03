CREATE TYPE "public"."aggregation" AS ENUM('sum', 'mean', 'median', 'last', 'min', 'max', 'count');--> statement-breakpoint
CREATE TYPE "public"."ai_purpose" AS ENUM('narration', 'parsing', 'classification', 'embedding', 'ask', 'review_draft', 'extraction');--> statement-breakpoint
CREATE TYPE "public"."audit_operation" AS ENUM('insert', 'update', 'soft_delete', 'restore', 'purge');--> statement-breakpoint
CREATE TYPE "public"."body_region" AS ENUM('face', 'chest', 'back', 'shoulders', 'arms', 'neck', 'other');--> statement-breakpoint
CREATE TYPE "public"."capture_distance" AS ENUM('close', 'medium', 'full');--> statement-breakpoint
CREATE TYPE "public"."capture_lighting" AS ENUM('daylight_indirect', 'daylight_direct', 'artificial_warm', 'artificial_cool', 'mixed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."capture_time_bucket" AS ENUM('early_morning', 'morning', 'midday', 'afternoon', 'evening', 'night');--> statement-breakpoint
CREATE TYPE "public"."condition_status" AS ENUM('suspected', 'active', 'remission', 'resolved', 'refuted');--> statement-breakpoint
CREATE TYPE "public"."consent_scope" AS ENUM('none', 'aggregates_only', 'non_clinical', 'clinical', 'journal');--> statement-breakpoint
CREATE TYPE "public"."document_kind" AS ENUM('prescription', 'lab_report', 'imaging', 'discharge_summary', 'insurance', 'receipt', 'identity', 'other');--> statement-breakpoint
CREATE TYPE "public"."domain" AS ENUM('body', 'mind', 'work', 'money', 'life', 'system');--> statement-breakpoint
CREATE TYPE "public"."equipment_kind" AS ENUM('barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'kettlebell', 'band', 'other');--> statement-breakpoint
CREATE TYPE "public"."exercise_mechanic" AS ENUM('compound', 'isolation');--> statement-breakpoint
CREATE TYPE "public"."extraction_method" AS ENUM('ocr', 'model', 'manual', 'native_text');--> statement-breakpoint
CREATE TYPE "public"."flash_state" AS ENUM('on', 'off', 'auto_fired', 'auto_not_fired');--> statement-breakpoint
CREATE TYPE "public"."goal_status" AS ENUM('active', 'achieved', 'abandoned', 'paused', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."graph_node_kind" AS ENUM('entity', 'concept', 'event', 'metric', 'person', 'place');--> statement-breakpoint
CREATE TYPE "public"."insight_disposition" AS ENUM('new', 'seen', 'acted_on', 'dismissed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."lab_flag" AS ENUM('normal', 'low', 'high', 'critical_low', 'critical_high', 'abnormal', 'indeterminate');--> statement-breakpoint
CREATE TYPE "public"."media_kind" AS ENUM('image', 'video', 'audio', 'pdf', 'other');--> statement-breakpoint
CREATE TYPE "public"."medical_event_type" AS ENUM('condition', 'medication', 'medication_schedule', 'lab_panel', 'appointment', 'procedure', 'treatment_course', 'side_effect', 'symptom');--> statement-breakpoint
CREATE TYPE "public"."medication_event_kind" AS ENUM('taken', 'skipped', 'delayed');--> statement-breakpoint
CREATE TYPE "public"."medication_form" AS ENUM('tablet', 'capsule', 'liquid', 'topical', 'injection', 'inhaler', 'drops', 'patch', 'other');--> statement-breakpoint
CREATE TYPE "public"."medication_stop_reason" AS ENUM('course_completed', 'ineffective', 'side_effects', 'switched', 'prescriber_advice', 'self_discontinued', 'unavailable', 'other');--> statement-breakpoint
CREATE TYPE "public"."metric_value_type" AS ENUM('numeric', 'integer', 'boolean', 'text', 'duration', 'categorical');--> statement-breakpoint
CREATE TYPE "public"."muscle_group" AS ENUM('chest', 'back', 'shoulders', 'biceps', 'triceps', 'forearms', 'quads', 'hamstrings', 'glutes', 'calves', 'core', 'full_body');--> statement-breakpoint
CREATE TYPE "public"."practice_kind" AS ENUM('meditation', 'breathwork', 'grounding', 'journaling', 'other');--> statement-breakpoint
CREATE TYPE "public"."product_event_kind" AS ENUM('introduced', 'discontinued', 'repurchased', 'reaction', 'finished');--> statement-breakpoint
CREATE TYPE "public"."review_kind" AS ENUM('weekly', 'monthly', 'quarterly', 'annual');--> statement-breakpoint
CREATE TYPE "public"."review_state" AS ENUM('drafted', 'editing', 'complete');--> statement-breakpoint
CREATE TYPE "public"."routine_kind" AS ENUM('skincare', 'dental', 'supplement', 'other');--> statement-breakpoint
CREATE TYPE "public"."routine_period" AS ENUM('am', 'pm', 'midday', 'as_needed');--> statement-breakpoint
CREATE TYPE "public"."routine_step_status" AS ENUM('done', 'skipped', 'partial');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('mild', 'moderate', 'severe');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('manual', 'device_import', 'derivation', 'document_extraction', 'model_inference');--> statement-breakpoint
CREATE TYPE "public"."storage_tier" AS ENUM('public', 'private', 'sensitive');--> statement-breakpoint
CREATE TYPE "public"."treatment_outcome" AS ENUM('resolved', 'improved', 'no_change', 'worsened', 'discontinued', 'ongoing');--> statement-breakpoint
CREATE TYPE "public"."workout_set_kind" AS ENUM('working', 'warmup', 'drop', 'failure', 'backoff', 'amrap');--> statement-breakpoint
CREATE TABLE "crisis_plan" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"warning_signs" text,
	"coping_strategies" text,
	"reasons_to_live" text,
	"contacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"professional_contacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_consent" "consent_scope" DEFAULT 'none' NOT NULL,
	"last_reviewed_at" timestamp with time zone,
	CONSTRAINT "crisis_plan_never_shared_with_ai" CHECK ("crisis_plan"."ai_consent" = 'none')
);
--> statement-breakpoint
CREATE TABLE "feature_flag" (
	"key" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"description" text NOT NULL,
	"change_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"singleton" boolean DEFAULT true NOT NULL,
	"display_name" text NOT NULL,
	"date_of_birth" text,
	"sex_at_birth" text,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"locale" text DEFAULT 'en-GB' NOT NULL,
	"unit_system" text DEFAULT 'metric' NOT NULL,
	"clinical_context" text,
	CONSTRAINT "profile_singleton_true" CHECK ("profile"."singleton" IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_tag" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tag_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric" (
	"key" text PRIMARY KEY NOT NULL,
	"domain" "domain" NOT NULL,
	"display_name" text NOT NULL,
	"description" text NOT NULL,
	"value_type" "metric_value_type" NOT NULL,
	"canonical_unit" text NOT NULL,
	"min_value" numeric(20, 6),
	"max_value" numeric(20, 6),
	"aggregation" "aggregation" NOT NULL,
	"allowed_values" jsonb,
	"in_daily_close" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metric_range_ordered" CHECK ("metric"."min_value" IS NULL OR "metric"."max_value" IS NULL OR "metric"."min_value" <= "metric"."max_value")
);
--> statement-breakpoint
CREATE TABLE "metric_rollup" (
	"id" uuid PRIMARY KEY NOT NULL,
	"metric_key" text NOT NULL,
	"grain" text NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"value" numeric(20, 6) NOT NULL,
	"sample_count" integer NOT NULL,
	"min_value" numeric(20, 6),
	"max_value" numeric(20, 6),
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"metric_key" text NOT NULL,
	"value" numeric(20, 6) NOT NULL,
	"value_text" text,
	"unit" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"observed_zone" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_id" uuid NOT NULL,
	"confidence" numeric(5, 4),
	"subject_type" text,
	"subject_id" uuid,
	"context" jsonb,
	"superseded_by_id" uuid,
	"superseded_at" timestamp with time zone,
	"supersede_reason" text,
	"hlc" text NOT NULL,
	CONSTRAINT "observation_supersede_consistent" CHECK (("observation"."superseded_by_id" IS NULL) = ("observation"."superseded_at" IS NULL)),
	CONSTRAINT "observation_no_self_supersede" CHECK ("observation"."superseded_by_id" IS NULL OR "observation"."superseded_by_id" <> "observation"."id"),
	CONSTRAINT "observation_subject_paired" CHECK (("observation"."subject_type" IS NULL) = ("observation"."subject_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "observation_source" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "source_kind" NOT NULL,
	"identifier" text NOT NULL,
	"version" text,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sample" (
	"id" uuid PRIMARY KEY NOT NULL,
	"metric_key" text NOT NULL,
	"value" numeric(20, 6) NOT NULL,
	"unit" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"observed_zone" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_id" uuid NOT NULL,
	"is_downsampled" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"colour" text
);
--> statement-breakpoint
CREATE TABLE "appointment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"recorded_from" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_to" timestamp with time zone,
	"medical_event_id" uuid NOT NULL,
	"provider" text,
	"specialty" text,
	"location" text,
	"scheduled_for" timestamp with time zone,
	"zone" text,
	"attended_at" timestamp with time zone,
	"pre_visit_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"post_visit_notes" text,
	"outcome" text,
	"follow_up_due" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "condition" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"recorded_from" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_to" timestamp with time zone,
	"medical_event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"code_system" text,
	"status" "condition_status" DEFAULT 'active' NOT NULL,
	"severity" "severity",
	"diagnosed_by" text,
	"resolution_note" text
);
--> statement-breakpoint
CREATE TABLE "lab_panel" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"recorded_from" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_to" timestamp with time zone,
	"medical_event_id" uuid NOT NULL,
	"panel_name" text NOT NULL,
	"laboratory" text,
	"ordered_by" text,
	"collected_at" timestamp with time zone,
	"reported_at" timestamp with time zone,
	"document_id" uuid
);
--> statement-breakpoint
CREATE TABLE "lab_result" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"lab_panel_id" uuid NOT NULL,
	"analyte" text NOT NULL,
	"code" text,
	"value" numeric(20, 6),
	"value_text" text,
	"unit" text,
	"reference_low" numeric(20, 6),
	"reference_high" numeric(20, 6),
	"reference_text" text,
	"flag" "lab_flag",
	"observation_id" uuid
);
--> statement-breakpoint
CREATE TABLE "medical_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"recorded_from" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_to" timestamp with time zone,
	"type" "medical_event_type" NOT NULL,
	"title" text NOT NULL,
	"narrative" text,
	"severity" "severity",
	"confidence" numeric(5, 4),
	"source_description" text,
	"document_id" uuid,
	"zone" text,
	CONSTRAINT "medical_event_valid_ordered" CHECK ("medical_event"."valid_to" IS NULL OR "medical_event"."valid_from" <= "medical_event"."valid_to"),
	CONSTRAINT "medical_event_recorded_ordered" CHECK ("medical_event"."recorded_to" IS NULL OR "medical_event"."recorded_from" <= "medical_event"."recorded_to")
);
--> statement-breakpoint
CREATE TABLE "medication" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"recorded_from" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_to" timestamp with time zone,
	"medical_event_id" uuid NOT NULL,
	"substance" text NOT NULL,
	"brand_name" text,
	"form" "medication_form" NOT NULL,
	"strength" numeric(20, 6),
	"strength_unit" text,
	"indication" text,
	"condition_id" uuid,
	"prescriber" text,
	"started_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"stop_reason" "medication_stop_reason",
	"stop_note" text,
	"is_psychiatric" boolean DEFAULT false NOT NULL,
	CONSTRAINT "medication_stop_paired" CHECK ("medication"."stopped_at" IS NOT NULL OR "medication"."stop_reason" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "medication_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"medication_id" uuid NOT NULL,
	"schedule_id" uuid,
	"kind" "medication_event_kind" NOT NULL,
	"scheduled_for" timestamp with time zone,
	"taken_at" timestamp with time zone,
	"zone" text,
	"dose_taken" numeric(20, 6),
	"note" text,
	CONSTRAINT "medication_event_taken_paired" CHECK ("medication_event"."kind" <> 'taken' OR "medication_event"."taken_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "medication_schedule" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"recorded_from" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_to" timestamp with time zone,
	"medication_id" uuid NOT NULL,
	"dose" numeric(20, 6) NOT NULL,
	"dose_unit" text NOT NULL,
	"frequency" text NOT NULL,
	"times" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"with_food" boolean,
	"instructions" text
);
--> statement-breakpoint
CREATE TABLE "procedure" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"recorded_from" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_to" timestamp with time zone,
	"medical_event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"performed_by" text,
	"location" text,
	"tooth_notation" text,
	"body_site" text,
	"performed_at" timestamp with time zone,
	"outcome" text,
	"complications" text,
	"cost_minor" integer,
	"currency" text
);
--> statement-breakpoint
CREATE TABLE "side_effect" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"recorded_from" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_to" timestamp with time zone,
	"medical_event_id" uuid NOT NULL,
	"suspected_medication_id" uuid,
	"effect" text NOT NULL,
	"severity" "severity",
	"onset_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"reported_to_prescriber" boolean DEFAULT false NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "symptom" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"recorded_from" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_to" timestamp with time zone,
	"medical_event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"body_site" text,
	"severity" "severity",
	"intensity" integer,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"zone" text,
	"suspected_trigger" text,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "treatment_course" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"recorded_from" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_to" timestamp with time zone,
	"medical_event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"condition_id" uuid,
	"medication_id" uuid,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"cumulative_dose" numeric(20, 6),
	"cumulative_dose_unit" text,
	"dosing_note" text,
	"outcome" "treatment_outcome",
	"outcome_note" text,
	"prescriber" text
);
--> statement-breakpoint
CREATE TABLE "body_measurement" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"measured_at" timestamp with time zone NOT NULL,
	"zone" text NOT NULL,
	"site" text NOT NULL,
	"value" numeric(20, 6) NOT NULL,
	"unit" text DEFAULT 'cm' NOT NULL,
	"side" text,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "exercise" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"primary_muscle" "muscle_group" NOT NULL,
	"secondary_muscles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mechanic" "exercise_mechanic",
	"equipment" "equipment_kind",
	"is_bodyweight" boolean DEFAULT false NOT NULL,
	"is_unilateral" boolean DEFAULT false NOT NULL,
	"instructions" text,
	"form_notes" text
);
--> statement-breakpoint
CREATE TABLE "product_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"product_id" uuid NOT NULL,
	"kind" "product_event_kind" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"zone" text,
	"reaction_description" text,
	"reaction_severity" "severity",
	"note" text
);
--> statement-breakpoint
CREATE TABLE "program" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"name" text NOT NULL,
	"description" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"is_active" boolean DEFAULT false NOT NULL,
	"target_frequency" integer
);
--> statement-breakpoint
CREATE TABLE "program_block" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"program_id" uuid NOT NULL,
	"name" text NOT NULL,
	"order_index" integer NOT NULL,
	"prescription" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "routine" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"kind" "routine_kind" NOT NULL,
	"period" "routine_period" NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"expected_at" text
);
--> statement-breakpoint
CREATE TABLE "routine_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"routine_id" uuid NOT NULL,
	"step_id" uuid,
	"occurred_on" text NOT NULL,
	"completed_at" timestamp with time zone,
	"zone" text,
	"status" "routine_step_status" NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "routine_step" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"routine_id" uuid NOT NULL,
	"order_index" integer NOT NULL,
	"label" text NOT NULL,
	"product_id" uuid,
	"medication_id" uuid,
	"is_optional" boolean DEFAULT false NOT NULL,
	"instructions" text
);
--> statement-breakpoint
CREATE TABLE "skin_region_state" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"skin_state_id" uuid NOT NULL,
	"region" "body_region" NOT NULL,
	"state" integer,
	"severity" "severity",
	"active_lesion_count" integer,
	"scarring_level" integer,
	"inflammation" integer,
	"dryness" integer,
	"oiliness" integer,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "skin_state" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"observed_on" text NOT NULL,
	"zone" text NOT NULL,
	"overall_state" integer,
	"note" text,
	"is_flare" boolean DEFAULT false NOT NULL,
	"suspected_trigger" text
);
--> statement-breakpoint
CREATE TABLE "skincare_product" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"name" text NOT NULL,
	"brand" text,
	"category" text,
	"key_ingredients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"full_ingredients" text,
	"is_active" boolean DEFAULT false NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "workout_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"program_id" uuid,
	"program_block_id" uuid,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"zone" text NOT NULL,
	"title" text,
	"location" text,
	"perceived_effort" integer,
	"notes" text,
	"bodyweight_at_session" numeric(20, 6),
	CONSTRAINT "workout_session_ordered" CHECK ("workout_session"."ended_at" IS NULL OR "workout_session"."started_at" <= "workout_session"."ended_at")
);
--> statement-breakpoint
CREATE TABLE "workout_set" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"session_id" uuid NOT NULL,
	"exercise_id" uuid NOT NULL,
	"order_index" integer NOT NULL,
	"kind" "workout_set_kind" DEFAULT 'working' NOT NULL,
	"load" numeric(20, 6),
	"load_unit" text DEFAULT 'kg' NOT NULL,
	"reps" integer,
	"rpe" numeric(20, 6),
	"rest_seconds" integer,
	"superset_group" integer,
	"side" text,
	"performed_at" timestamp with time zone NOT NULL,
	"is_personal_record" boolean DEFAULT false NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "anxiety_episode" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"zone" text NOT NULL,
	"intensity" integer,
	"severity" "severity",
	"physical_symptoms" text,
	"trigger" text,
	"coping_response" text,
	"outcome" text,
	"note" text,
	"ai_consent" "consent_scope" DEFAULT 'none' NOT NULL,
	CONSTRAINT "anxiety_episode_ordered" CHECK ("anxiety_episode"."ended_at" IS NULL OR "anxiety_episode"."started_at" <= "anxiety_episode"."ended_at")
);
--> statement-breakpoint
CREATE TABLE "journal_entry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"written_at" timestamp with time zone NOT NULL,
	"zone" text NOT NULL,
	"title" text,
	"content" text NOT NULL,
	"prompt_id" uuid,
	"mood_at_writing" integer,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, ''))) STORED,
	"ai_consent" "consent_scope" DEFAULT 'none' NOT NULL,
	CONSTRAINT "journal_entry_consent_restricted" CHECK ("journal_entry"."ai_consent" IN ('none', 'journal'))
);
--> statement-breakpoint
CREATE TABLE "journal_prompt" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"prompt" text NOT NULL,
	"category" text,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "practice_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"kind" "practice_kind" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"zone" text NOT NULL,
	"duration_minutes" numeric(20, 6),
	"method" text,
	"state_before" integer,
	"state_after" integer,
	"note" text,
	"ai_consent" "consent_scope" DEFAULT 'none' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "therapy_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"zone" text NOT NULL,
	"therapist" text,
	"modality" text,
	"themes" text,
	"action_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"follow_up_at" timestamp with time zone,
	"note" text,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(themes, '') || ' ' || coalesce(note, ''))) STORED,
	"is_model_generated" boolean DEFAULT false NOT NULL,
	"ai_consent" "consent_scope" DEFAULT 'none' NOT NULL,
	CONSTRAINT "therapy_session_user_authored" CHECK ("therapy_session"."is_model_generated" IS FALSE),
	CONSTRAINT "therapy_session_consent_restricted" CHECK ("therapy_session"."ai_consent" IN ('none', 'journal'))
);
--> statement-breakpoint
CREATE TABLE "food" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"name" text NOT NULL,
	"brand" text,
	"gtin" text,
	"last_eaten_at" timestamp with time zone,
	"times_eaten" integer DEFAULT 0 NOT NULL,
	"is_vegetarian" boolean,
	"is_vegan" boolean
);
--> statement-breakpoint
CREATE TABLE "food_nutrient" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"food_version_id" uuid NOT NULL,
	"nutrient_key" text NOT NULL,
	"amount" numeric(20, 6) NOT NULL,
	"unit" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "food_version" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"food_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"basis_quantity" numeric(20, 6) NOT NULL,
	"basis_unit" text NOT NULL,
	"serving_quantity" numeric(20, 6),
	"serving_unit" text,
	"serving_label" text,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"source_note" text
);
--> statement-breakpoint
CREATE TABLE "meal" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"eaten_at" timestamp with time zone NOT NULL,
	"zone" text NOT NULL,
	"slot" text,
	"note" text,
	"template_id" uuid
);
--> statement-breakpoint
CREATE TABLE "meal_item" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"meal_id" uuid NOT NULL,
	"food_version_id" uuid NOT NULL,
	"quantity" numeric(20, 6) NOT NULL,
	"unit" text NOT NULL,
	"parsed_from_text" text
);
--> statement-breakpoint
CREATE TABLE "meal_template" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"name" text NOT NULL,
	"slot" text,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"times_used" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nutrition_target" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"phase" text,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"metric_key" text NOT NULL,
	"target_value" numeric(20, 6) NOT NULL,
	"unit" text NOT NULL,
	"tolerance_low" numeric(20, 6),
	"tolerance_high" numeric(20, 6)
);
--> statement-breakpoint
CREATE TABLE "document" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"kind" "document_kind" NOT NULL,
	"title" text NOT NULL,
	"issuer" text,
	"issued_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"media_object_id" uuid,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "document_extraction" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"document_id" uuid NOT NULL,
	"method" "extraction_method" NOT NULL,
	"engine" text,
	"engine_version" text,
	"extracted_text" text,
	"structured_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"overall_confidence" numeric(5, 4),
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(extracted_text, ''))) STORED
);
--> statement-breakpoint
CREATE TABLE "goal" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"title" text NOT NULL,
	"description" text,
	"status" "goal_status" DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone,
	"horizon_at" timestamp with time zone,
	"achieved_at" timestamp with time zone,
	"closing_note" text,
	"supersedes_goal_id" uuid
);
--> statement-breakpoint
CREATE TABLE "goal_progress_snapshot" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"goal_id" uuid NOT NULL,
	"goal_target_id" uuid,
	"taken_at" timestamp with time zone NOT NULL,
	"current_value" numeric(20, 6),
	"progress_ratio" numeric(20, 6),
	"projected_at" timestamp with time zone,
	"projection_confidence" numeric(5, 4)
);
--> statement-breakpoint
CREATE TABLE "goal_target" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"goal_id" uuid NOT NULL,
	"metric_key" text NOT NULL,
	"comparator" text NOT NULL,
	"target_value" numeric(20, 6) NOT NULL,
	"unit" text NOT NULL,
	"window_days" integer
);
--> statement-breakpoint
CREATE TABLE "insight" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"method" text NOT NULL,
	"detector_version" text,
	"title" text NOT NULL,
	"narrative" text,
	"limitations" text,
	"confidence" numeric(5, 4),
	"p_value" numeric(20, 6),
	"effect_size" numeric(20, 6),
	"disposition" "insight_disposition" DEFAULT 'new' NOT NULL,
	"surfaced_at" timestamp with time zone,
	"acted_on_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"dismiss_reason" text
);
--> statement-breakpoint
CREATE TABLE "insight_evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"insight_id" uuid NOT NULL,
	"observation_id" uuid,
	"entity_type" text,
	"entity_id" uuid,
	"role" text,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "media_access_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"media_object_id" uuid NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purpose" text NOT NULL,
	"granted_consent" "consent_scope",
	"is_decrypted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_attachment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"media_object_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"order_index" integer,
	"caption" text
);
--> statement-breakpoint
CREATE TABLE "media_object" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"kind" "media_kind" NOT NULL,
	"tier" "storage_tier" NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" bigint,
	"width" integer,
	"height" integer,
	"perceptual_hash" text,
	"content_hash" text,
	"captured_at" timestamp with time zone,
	"captured_zone" text,
	"device_identity" text,
	"wrapped_key" text,
	"encryption_algorithm" text,
	"protocol_region" "body_region",
	"pose_id" text,
	"distance" "capture_distance",
	"lighting" "capture_lighting",
	"flash" "flash_state",
	"time_bucket" "capture_time_bucket",
	"alignment_reference_id" uuid,
	"median_luminance" numeric(20, 6),
	"compliance_score" numeric(5, 4),
	"compliance_notes" text,
	"ai_consent" "consent_scope" DEFAULT 'none' NOT NULL,
	CONSTRAINT "media_object_sensitive_encrypted" CHECK ("media_object"."tier" <> 'sensitive' OR "media_object"."wrapped_key" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "note" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"entity_type" text,
	"entity_id" uuid,
	"content" text NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED,
	"ai_consent" "consent_scope" DEFAULT 'none' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"kind" "review_kind" NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"draft_content" text,
	"edited_content" text,
	"state" "review_state" DEFAULT 'drafted' NOT NULL,
	"completed_at" timestamp with time zone,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(draft_content, '') || ' ' || coalesce(edited_content, ''))) STORED,
	CONSTRAINT "review_complete_requires_edit" CHECK ("review"."state" <> 'complete' OR "review"."edited_content" IS NOT NULL),
	CONSTRAINT "review_period_ordered" CHECK ("review"."period_start" <= "review"."period_end")
);
--> statement-breakpoint
CREATE TABLE "ai_interaction" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purpose" "ai_purpose" NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"cache_write_tokens" integer,
	"cost_minor" integer,
	"currency" text,
	"latency_ms" integer,
	"consent_scope" "consent_scope" NOT NULL,
	"output_hash" text,
	"blocked_reason" text,
	"succeeded" boolean DEFAULT true NOT NULL,
	"error_code" text
);
--> statement-breakpoint
CREATE TABLE "embedding" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"chunk_index" integer DEFAULT 0 NOT NULL,
	"chunk_text" text NOT NULL,
	"chunk_start" integer,
	"chunk_end" integer,
	"vector" vector(384) NOT NULL,
	"model_identity" text NOT NULL,
	"model_version" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_edge" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"source_node_id" uuid NOT NULL,
	"target_node_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"weight" numeric(20, 6),
	"confidence" numeric(5, 4),
	"observation_ids" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_node" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"kind" "graph_node_kind" NOT NULL,
	"label" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_fact" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"key" text NOT NULL,
	"fact" text NOT NULL,
	"category" text,
	"confidence" numeric(5, 4),
	"derived_from" text,
	"last_confirmed_at" timestamp with time zone,
	"ai_consent" "consent_scope" DEFAULT 'none' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"value" bigint,
	"route" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"zone" text,
	"device_class" text,
	"schema_version" text
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"operation" "audit_operation" NOT NULL,
	"entity_version" integer,
	"before_state" jsonb,
	"after_state" jsonb,
	"changed_fields" jsonb,
	"actor" text NOT NULL,
	"change_reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"zone" text,
	"trace_id" text
);
--> statement-breakpoint
CREATE TABLE "idempotency_record" (
	"key" text PRIMARY KEY NOT NULL,
	"request_fingerprint" text NOT NULL,
	"endpoint" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"is_complete" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_name" text NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"is_manual" boolean DEFAULT false NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rows_affected" integer,
	"error_message" text,
	"trace_id" text
);
--> statement-breakpoint
CREATE TABLE "schema_migration" (
	"id" text PRIMARY KEY NOT NULL,
	"checksum" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_by" text,
	"is_data_migration" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_id" text NOT NULL,
	"device_label" text,
	"watermark" bigint DEFAULT 0 NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"schema_version" text NOT NULL,
	"clock_skew_ms" integer,
	"pending_writes" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entity_tag" ADD CONSTRAINT "entity_tag_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_rollup" ADD CONSTRAINT "metric_rollup_metric_key_metric_key_fk" FOREIGN KEY ("metric_key") REFERENCES "public"."metric"("key") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_metric_key_metric_key_fk" FOREIGN KEY ("metric_key") REFERENCES "public"."metric"("key") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "observation" ADD CONSTRAINT "observation_source_id_observation_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."observation_source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample" ADD CONSTRAINT "sample_metric_key_metric_key_fk" FOREIGN KEY ("metric_key") REFERENCES "public"."metric"("key") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sample" ADD CONSTRAINT "sample_source_id_observation_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."observation_source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_medical_event_id_medical_event_id_fk" FOREIGN KEY ("medical_event_id") REFERENCES "public"."medical_event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "condition" ADD CONSTRAINT "condition_medical_event_id_medical_event_id_fk" FOREIGN KEY ("medical_event_id") REFERENCES "public"."medical_event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_panel" ADD CONSTRAINT "lab_panel_medical_event_id_medical_event_id_fk" FOREIGN KEY ("medical_event_id") REFERENCES "public"."medical_event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_result" ADD CONSTRAINT "lab_result_lab_panel_id_lab_panel_id_fk" FOREIGN KEY ("lab_panel_id") REFERENCES "public"."lab_panel"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication" ADD CONSTRAINT "medication_medical_event_id_medical_event_id_fk" FOREIGN KEY ("medical_event_id") REFERENCES "public"."medical_event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication" ADD CONSTRAINT "medication_condition_id_condition_id_fk" FOREIGN KEY ("condition_id") REFERENCES "public"."condition"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_event" ADD CONSTRAINT "medication_event_medication_id_medication_id_fk" FOREIGN KEY ("medication_id") REFERENCES "public"."medication"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_event" ADD CONSTRAINT "medication_event_schedule_id_medication_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."medication_schedule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_schedule" ADD CONSTRAINT "medication_schedule_medication_id_medication_id_fk" FOREIGN KEY ("medication_id") REFERENCES "public"."medication"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure" ADD CONSTRAINT "procedure_medical_event_id_medical_event_id_fk" FOREIGN KEY ("medical_event_id") REFERENCES "public"."medical_event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "side_effect" ADD CONSTRAINT "side_effect_medical_event_id_medical_event_id_fk" FOREIGN KEY ("medical_event_id") REFERENCES "public"."medical_event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "side_effect" ADD CONSTRAINT "side_effect_suspected_medication_id_medication_id_fk" FOREIGN KEY ("suspected_medication_id") REFERENCES "public"."medication"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "symptom" ADD CONSTRAINT "symptom_medical_event_id_medical_event_id_fk" FOREIGN KEY ("medical_event_id") REFERENCES "public"."medical_event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_course" ADD CONSTRAINT "treatment_course_medical_event_id_medical_event_id_fk" FOREIGN KEY ("medical_event_id") REFERENCES "public"."medical_event"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_course" ADD CONSTRAINT "treatment_course_condition_id_condition_id_fk" FOREIGN KEY ("condition_id") REFERENCES "public"."condition"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_course" ADD CONSTRAINT "treatment_course_medication_id_medication_id_fk" FOREIGN KEY ("medication_id") REFERENCES "public"."medication"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_event" ADD CONSTRAINT "product_event_product_id_skincare_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."skincare_product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_block" ADD CONSTRAINT "program_block_program_id_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."program"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_log" ADD CONSTRAINT "routine_log_routine_id_routine_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routine"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_log" ADD CONSTRAINT "routine_log_step_id_routine_step_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."routine_step"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_step" ADD CONSTRAINT "routine_step_routine_id_routine_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routine"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_step" ADD CONSTRAINT "routine_step_product_id_skincare_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."skincare_product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skin_region_state" ADD CONSTRAINT "skin_region_state_skin_state_id_skin_state_id_fk" FOREIGN KEY ("skin_state_id") REFERENCES "public"."skin_state"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_session" ADD CONSTRAINT "workout_session_program_id_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."program"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_session" ADD CONSTRAINT "workout_session_program_block_id_program_block_id_fk" FOREIGN KEY ("program_block_id") REFERENCES "public"."program_block"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_set" ADD CONSTRAINT "workout_set_session_id_workout_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workout_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_set" ADD CONSTRAINT "workout_set_exercise_id_exercise_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercise"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_nutrient" ADD CONSTRAINT "food_nutrient_food_version_id_food_version_id_fk" FOREIGN KEY ("food_version_id") REFERENCES "public"."food_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_version" ADD CONSTRAINT "food_version_food_id_food_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."food"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_item" ADD CONSTRAINT "meal_item_meal_id_meal_id_fk" FOREIGN KEY ("meal_id") REFERENCES "public"."meal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_item" ADD CONSTRAINT "meal_item_food_version_id_food_version_id_fk" FOREIGN KEY ("food_version_id") REFERENCES "public"."food_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extraction" ADD CONSTRAINT "document_extraction_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_progress_snapshot" ADD CONSTRAINT "goal_progress_snapshot_goal_id_goal_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_progress_snapshot" ADD CONSTRAINT "goal_progress_snapshot_goal_target_id_goal_target_id_fk" FOREIGN KEY ("goal_target_id") REFERENCES "public"."goal_target"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_target" ADD CONSTRAINT "goal_target_goal_id_goal_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insight_evidence" ADD CONSTRAINT "insight_evidence_insight_id_insight_id_fk" FOREIGN KEY ("insight_id") REFERENCES "public"."insight"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_access_log" ADD CONSTRAINT "media_access_log_media_object_id_media_object_id_fk" FOREIGN KEY ("media_object_id") REFERENCES "public"."media_object"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_attachment" ADD CONSTRAINT "media_attachment_media_object_id_media_object_id_fk" FOREIGN KEY ("media_object_id") REFERENCES "public"."media_object"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_edge" ADD CONSTRAINT "graph_edge_source_node_id_graph_node_id_fk" FOREIGN KEY ("source_node_id") REFERENCES "public"."graph_node"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_edge" ADD CONSTRAINT "graph_edge_target_node_id_graph_node_id_fk" FOREIGN KEY ("target_node_id") REFERENCES "public"."graph_node"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "crisis_plan_one_active" ON "crisis_plan" USING btree ("is_active") WHERE "crisis_plan"."is_active" IS TRUE AND "crisis_plan"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "profile_singleton_unique" ON "profile" USING btree ("singleton");--> statement-breakpoint
CREATE INDEX "setting_key_idx" ON "setting" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_tag_unique" ON "entity_tag" USING btree ("tag_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "entity_tag_entity_idx" ON "entity_tag" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "metric_domain_idx" ON "metric" USING btree ("domain");--> statement-breakpoint
CREATE UNIQUE INDEX "metric_rollup_unique" ON "metric_rollup" USING btree ("metric_key","grain","bucket_start");--> statement-breakpoint
CREATE INDEX "metric_rollup_lookup_idx" ON "metric_rollup" USING btree ("metric_key","grain","bucket_start" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "observation_metric_observed_idx" ON "observation" USING btree ("metric_key","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "observation_observed_at_idx" ON "observation" USING btree ("observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "observation_subject_idx" ON "observation" USING btree ("subject_type","subject_id","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "observation_source_idx" ON "observation" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "observation_current_idx" ON "observation" USING btree ("metric_key","observed_at" DESC NULLS LAST) WHERE "observation"."superseded_by_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "observation_source_unique" ON "observation_source" USING btree ("kind","identifier","version");--> statement-breakpoint
CREATE INDEX "observation_source_kind_idx" ON "observation_source" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "sample_metric_observed_idx" ON "sample" USING btree ("metric_key","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "tag_slug_unique" ON "tag" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "appointment_scheduled_idx" ON "appointment" USING btree ("scheduled_for" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "appointment_upcoming_idx" ON "appointment" USING btree ("scheduled_for") WHERE "appointment"."attended_at" IS NULL AND "appointment"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "condition_status_idx" ON "condition" USING btree ("status") WHERE "condition"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "condition_event_idx" ON "condition" USING btree ("medical_event_id");--> statement-breakpoint
CREATE INDEX "lab_panel_collected_idx" ON "lab_panel" USING btree ("collected_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "lab_result_panel_idx" ON "lab_result" USING btree ("lab_panel_id");--> statement-breakpoint
CREATE INDEX "lab_result_analyte_idx" ON "lab_result" USING btree ("analyte");--> statement-breakpoint
CREATE INDEX "medical_event_valid_idx" ON "medical_event" USING btree ("valid_from" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "medical_event_type_idx" ON "medical_event" USING btree ("type","valid_from" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "medical_event_current_idx" ON "medical_event" USING btree ("type","valid_from" DESC NULLS LAST) WHERE "medical_event"."recorded_to" IS NULL AND "medical_event"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "medication_active_idx" ON "medication" USING btree ("substance") WHERE "medication"."stopped_at" IS NULL AND "medication"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "medication_event_idx" ON "medication" USING btree ("medical_event_id");--> statement-breakpoint
CREATE INDEX "medication_substance_trgm_idx" ON "medication" USING gin ("substance" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "medication_event_medication_idx" ON "medication_event" USING btree ("medication_id","scheduled_for" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "medication_event_kind_idx" ON "medication_event" USING btree ("kind","scheduled_for" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "medication_schedule_medication_idx" ON "medication_schedule" USING btree ("medication_id","valid_from" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "medication_schedule_believed_idx" ON "medication_schedule" USING btree ("medication_id","valid_from" DESC NULLS LAST) WHERE "medication_schedule"."recorded_to" IS NULL AND "medication_schedule"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "procedure_performed_idx" ON "procedure" USING btree ("performed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "procedure_tooth_idx" ON "procedure" USING btree ("tooth_notation") WHERE "procedure"."tooth_notation" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "side_effect_medication_idx" ON "side_effect" USING btree ("suspected_medication_id");--> statement-breakpoint
CREATE INDEX "symptom_started_idx" ON "symptom" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "treatment_course_started_idx" ON "treatment_course" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "treatment_course_condition_idx" ON "treatment_course" USING btree ("condition_id");--> statement-breakpoint
CREATE INDEX "body_measurement_site_idx" ON "body_measurement" USING btree ("site","measured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "exercise_slug_unique" ON "exercise" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "exercise_muscle_idx" ON "exercise" USING btree ("primary_muscle") WHERE "exercise"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "exercise_name_trgm_idx" ON "exercise" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "product_event_product_idx" ON "product_event" USING btree ("product_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "product_event_kind_idx" ON "product_event" USING btree ("kind","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "program_one_active" ON "program" USING btree ("is_active") WHERE "program"."is_active" IS TRUE AND "program"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "program_block_program_idx" ON "program_block" USING btree ("program_id","order_index");--> statement-breakpoint
CREATE UNIQUE INDEX "program_block_order_unique" ON "program_block" USING btree ("program_id","order_index");--> statement-breakpoint
CREATE INDEX "routine_active_idx" ON "routine" USING btree ("kind","period") WHERE "routine"."is_active" IS TRUE AND "routine"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "routine_log_routine_idx" ON "routine_log" USING btree ("routine_id","occurred_on");--> statement-breakpoint
CREATE UNIQUE INDEX "routine_log_unique" ON "routine_log" USING btree ("routine_id","step_id","occurred_on");--> statement-breakpoint
CREATE UNIQUE INDEX "routine_step_order_unique" ON "routine_step" USING btree ("routine_id","order_index");--> statement-breakpoint
CREATE UNIQUE INDEX "skin_region_state_unique" ON "skin_region_state" USING btree ("skin_state_id","region");--> statement-breakpoint
CREATE UNIQUE INDEX "skin_state_day_unique" ON "skin_state" USING btree ("observed_on");--> statement-breakpoint
CREATE INDEX "skincare_product_name_trgm_idx" ON "skincare_product" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "workout_session_started_idx" ON "workout_session" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "workout_session_program_idx" ON "workout_session" USING btree ("program_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "workout_set_session_idx" ON "workout_set" USING btree ("session_id","order_index");--> statement-breakpoint
CREATE INDEX "workout_set_exercise_idx" ON "workout_set" USING btree ("exercise_id","performed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "workout_set_pr_idx" ON "workout_set" USING btree ("exercise_id","performed_at" DESC NULLS LAST) WHERE "workout_set"."is_personal_record" IS TRUE;--> statement-breakpoint
CREATE UNIQUE INDEX "workout_set_order_unique" ON "workout_set" USING btree ("session_id","order_index");--> statement-breakpoint
CREATE INDEX "anxiety_episode_started_idx" ON "anxiety_episode" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "journal_entry_written_idx" ON "journal_entry" USING btree ("written_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "journal_entry_search_idx" ON "journal_entry" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "practice_session_started_idx" ON "practice_session" USING btree ("kind","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "therapy_session_occurred_idx" ON "therapy_session" USING btree ("occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "therapy_session_search_idx" ON "therapy_session" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "food_recent_idx" ON "food" USING btree ("last_eaten_at" DESC NULLS LAST) WHERE "food"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "food_frequent_idx" ON "food" USING btree ("times_eaten" DESC NULLS LAST) WHERE "food"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "food_name_trgm_idx" ON "food" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "food_gtin_unique" ON "food" USING btree ("gtin") WHERE "food"."gtin" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "food_nutrient_unique" ON "food_nutrient" USING btree ("food_version_id","nutrient_key");--> statement-breakpoint
CREATE UNIQUE INDEX "food_version_unique" ON "food_version" USING btree ("food_id","version_number");--> statement-breakpoint
CREATE INDEX "food_version_food_idx" ON "food_version" USING btree ("food_id","version_number" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "meal_eaten_idx" ON "meal" USING btree ("eaten_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "meal_item_meal_idx" ON "meal_item" USING btree ("meal_id");--> statement-breakpoint
CREATE INDEX "meal_item_food_version_idx" ON "meal_item" USING btree ("food_version_id");--> statement-breakpoint
CREATE INDEX "meal_template_recent_idx" ON "meal_template" USING btree ("last_used_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "nutrition_target_active_idx" ON "nutrition_target" USING btree ("metric_key","effective_from" DESC NULLS LAST) WHERE "nutrition_target"."effective_to" IS NULL AND "nutrition_target"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "document_kind_idx" ON "document" USING btree ("kind","issued_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "document_expiry_idx" ON "document" USING btree ("expires_at") WHERE "document"."expires_at" IS NOT NULL AND "document"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "document_extraction_document_idx" ON "document_extraction" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_extraction_search_idx" ON "document_extraction" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "goal_status_idx" ON "goal" USING btree ("status") WHERE "goal"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "goal_progress_snapshot_goal_idx" ON "goal_progress_snapshot" USING btree ("goal_id","taken_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "goal_target_goal_idx" ON "goal_target" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "insight_disposition_idx" ON "insight" USING btree ("disposition","surfaced_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "insight_queue_idx" ON "insight" USING btree ("confidence" DESC NULLS LAST) WHERE "insight"."disposition" = 'new' AND "insight"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "insight_evidence_insight_idx" ON "insight_evidence" USING btree ("insight_id");--> statement-breakpoint
CREATE INDEX "media_access_log_object_idx" ON "media_access_log" USING btree ("media_object_id","accessed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "media_attachment_unique" ON "media_attachment" USING btree ("media_object_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "media_attachment_entity_idx" ON "media_attachment" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_object_storage_key_unique" ON "media_object" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "media_object_series_idx" ON "media_object" USING btree ("protocol_region","pose_id","captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "media_object_hash_idx" ON "media_object" USING btree ("perceptual_hash") WHERE "media_object"."perceptual_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "note_entity_idx" ON "note" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "note_search_idx" ON "note" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX "review_period_unique" ON "review" USING btree ("kind","period_start");--> statement-breakpoint
CREATE INDEX "review_search_idx" ON "review" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "ai_interaction_created_idx" ON "ai_interaction" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ai_interaction_purpose_idx" ON "ai_interaction" USING btree ("purpose","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ai_interaction_cost_idx" ON "ai_interaction" USING btree ("created_at" DESC NULLS LAST) WHERE "ai_interaction"."cost_minor" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_chunk_unique" ON "embedding" USING btree ("source_type","source_id","chunk_index","model_version");--> statement-breakpoint
CREATE INDEX "embedding_source_idx" ON "embedding" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "embedding_hnsw_idx" ON "embedding" USING hnsw ("vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "graph_edge_source_idx" ON "graph_edge" USING btree ("source_node_id","relation");--> statement-breakpoint
CREATE INDEX "graph_edge_target_idx" ON "graph_edge" USING btree ("target_node_id","relation");--> statement-breakpoint
CREATE UNIQUE INDEX "graph_edge_unique" ON "graph_edge" USING btree ("source_node_id","target_node_id","relation");--> statement-breakpoint
CREATE INDEX "graph_node_kind_idx" ON "graph_node" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX "graph_node_entity_unique" ON "graph_node" USING btree ("entity_type","entity_id") WHERE "graph_node"."entity_type" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_fact_key_unique" ON "memory_fact" USING btree ("key");--> statement-breakpoint
CREATE INDEX "app_event_name_idx" ON "app_event" USING btree ("name","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "app_event_occurred_idx" ON "app_event" USING btree ("occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_occurred_idx" ON "audit_log" USING btree ("occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idempotency_record_expiry_idx" ON "idempotency_record" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "job_run_name_idx" ON "job_run" USING btree ("job_name","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "job_run_failed_idx" ON "job_run" USING btree ("started_at" DESC NULLS LAST) WHERE "job_run"."status" = 'failed';--> statement-breakpoint
CREATE INDEX "schema_migration_applied_idx" ON "schema_migration" USING btree ("applied_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "sync_state_device_unique" ON "sync_state" USING btree ("device_id");