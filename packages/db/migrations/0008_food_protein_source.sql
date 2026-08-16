CREATE TYPE "public"."protein_source" AS ENUM('dairy', 'egg', 'legume', 'supplement', 'grain_other');--> statement-breakpoint
ALTER TABLE "food" ADD COLUMN "protein_source" "protein_source";