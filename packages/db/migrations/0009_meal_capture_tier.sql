CREATE TYPE "public"."meal_capture_tier" AS ENUM('template', 'suggestion', 'parsed', 'manual');--> statement-breakpoint
ALTER TABLE "meal" ADD COLUMN "capture_tier" "meal_capture_tier";