CREATE TYPE "public"."account_kind" AS ENUM('current', 'savings', 'credit_card', 'investment', 'loan', 'cash', 'wallet', 'other');--> statement-breakpoint
CREATE TYPE "public"."budget_period" AS ENUM('weekly', 'monthly', 'quarterly', 'annual');--> statement-breakpoint
CREATE TYPE "public"."shopping_status" AS ENUM('wanted', 'purchased', 'dropped');--> statement-breakpoint
CREATE TYPE "public"."spend_category" AS ENUM('groceries', 'eating_out', 'supplements', 'skincare', 'health', 'fitness', 'rent', 'utilities', 'transport', 'subscriptions', 'shopping', 'travel', 'education', 'gifts', 'fees', 'income', 'transfer', 'other');--> statement-breakpoint
CREATE TYPE "public"."subscription_cadence" AS ENUM('weekly', 'monthly', 'quarterly', 'annual');--> statement-breakpoint
CREATE TABLE "account_balance" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"account_id" uuid NOT NULL,
	"as_of_day_key" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"category" "spend_category" NOT NULL,
	"period" "budget_period" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"note" text,
	CONSTRAINT "budget_dates_ordered" CHECK ("budget"."effective_to" IS NULL OR "budget"."effective_from" <= "budget"."effective_to")
);
--> statement-breakpoint
CREATE TABLE "financial_account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"name" text NOT NULL,
	"kind" "account_kind" NOT NULL,
	"institution" text,
	"currency" text NOT NULL,
	"is_liability" boolean DEFAULT false NOT NULL,
	"opened_on" date,
	"closed_on" date,
	"note" text,
	CONSTRAINT "financial_account_dates_ordered" CHECK ("financial_account"."closed_on" IS NULL OR "financial_account"."opened_on" IS NULL OR "financial_account"."opened_on" <= "financial_account"."closed_on")
);
--> statement-breakpoint
CREATE TABLE "money_transaction" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"account_id" uuid,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"zone" text,
	"day_key" text NOT NULL,
	"raw_description" text,
	"merchant" text,
	"category" "spend_category",
	"is_category_confirmed" boolean DEFAULT false NOT NULL,
	"subscription_id" uuid,
	"import_hash" text,
	"imported_at" timestamp with time zone,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "shopping_item" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"name" text NOT NULL,
	"status" "shopping_status" DEFAULT 'wanted' NOT NULL,
	"category" "spend_category",
	"quantity" integer,
	"amount_minor" bigint,
	"currency" text,
	"purchased_at" timestamp with time zone,
	"transaction_id" uuid,
	"linked_entity_type" text,
	"linked_entity_id" uuid,
	"note" text,
	CONSTRAINT "shopping_item_purchase_together" CHECK ("shopping_item"."status" <> 'purchased' OR "shopping_item"."purchased_at" IS NOT NULL),
	CONSTRAINT "shopping_item_amount_paired" CHECK (("shopping_item"."amount_minor" IS NULL) = ("shopping_item"."currency" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "subscription" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"name" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"cadence" "subscription_cadence" NOT NULL,
	"category" "spend_category",
	"account_id" uuid,
	"started_on" date,
	"cancelled_on" date,
	"cancellation_note" text,
	"next_due_on" date,
	"last_reviewed_on" date,
	"note" text,
	CONSTRAINT "subscription_dates_ordered" CHECK ("subscription"."cancelled_on" IS NULL OR "subscription"."started_on" IS NULL OR "subscription"."started_on" <= "subscription"."cancelled_on")
);
--> statement-breakpoint
ALTER TABLE "account_balance" ADD CONSTRAINT "account_balance_account_id_financial_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."financial_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transaction" ADD CONSTRAINT "money_transaction_account_id_financial_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."financial_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_item" ADD CONSTRAINT "shopping_item_transaction_id_money_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."money_transaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_account_id_financial_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."financial_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_balance_day_unique" ON "account_balance" USING btree ("account_id","as_of_day_key");--> statement-breakpoint
CREATE INDEX "account_balance_day_idx" ON "account_balance" USING btree ("as_of_day_key" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "budget_category_unique" ON "budget" USING btree ("category","period","effective_from") WHERE "budget"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "financial_account_kind_idx" ON "financial_account" USING btree ("kind") WHERE "financial_account"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "money_transaction_day_idx" ON "money_transaction" USING btree ("day_key" DESC NULLS LAST) WHERE "money_transaction"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "money_transaction_category_idx" ON "money_transaction" USING btree ("category","day_key" DESC NULLS LAST) WHERE "money_transaction"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "money_transaction_account_idx" ON "money_transaction" USING btree ("account_id") WHERE "money_transaction"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "money_transaction_import_unique" ON "money_transaction" USING btree ("import_hash") WHERE "money_transaction"."import_hash" IS NOT NULL AND "money_transaction"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "shopping_item_status_idx" ON "shopping_item" USING btree ("status") WHERE "shopping_item"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "shopping_item_linked_idx" ON "shopping_item" USING btree ("linked_entity_type","linked_entity_id");--> statement-breakpoint
CREATE INDEX "subscription_active_idx" ON "subscription" USING btree ("next_due_on") WHERE "subscription"."cancelled_on" IS NULL AND "subscription"."deleted_at" IS NULL;--> statement-breakpoint

-- §5.4's RLS posture, extended to the six tables above.
--
-- Same block as 0004, 0007, 0011 and 0012, for the same reason: none of them
-- can cover a table added afterwards, Postgres never complains about the gap,
-- and `rls.test.ts` is what actually holds the line. Enabled, FORCEd, no
-- policies — so the PostgREST path reaches a database that returns nothing even
-- holding the anon key that ships in the browser bundle.
--
-- `money_transaction` is the one worth naming here. A complete transaction
-- history is a movement log: where the operator was, when, and how often. It
-- reveals more about a life than most of the clinical tables do, and it is the
-- table an attacker would want most after `journal_entry`.
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
