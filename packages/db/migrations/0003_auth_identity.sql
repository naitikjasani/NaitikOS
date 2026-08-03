CREATE TYPE "public"."app_role" AS ENUM('owner', 'clinician', 'delegate', 'service');--> statement-breakpoint
CREATE TYPE "public"."auth_strategy" AS ENUM('password', 'magic_link', 'passkey', 'oauth_google');--> statement-breakpoint
CREATE TABLE "auth_identity" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"subject_id" text NOT NULL,
	"email" text NOT NULL,
	"profile_id" uuid NOT NULL,
	"role" "app_role" DEFAULT 'owner' NOT NULL,
	"last_sign_in_at" timestamp with time zone,
	"last_strategy" "auth_strategy",
	"disabled_at" timestamp with time zone,
	"disabled_reason" text
);
--> statement-breakpoint
ALTER TABLE "auth_identity" ADD CONSTRAINT "auth_identity_profile_id_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identity_subject_unique" ON "auth_identity" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "auth_identity_active_idx" ON "auth_identity" USING btree ("subject_id") WHERE "auth_identity"."disabled_at" IS NULL AND "auth_identity"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "auth_identity_email_idx" ON "auth_identity" USING btree ("email");