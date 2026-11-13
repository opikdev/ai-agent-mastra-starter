CREATE TABLE "idempotency_keys" (
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"run_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_idempotency_keys" PRIMARY KEY("id")
);
--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "chk_runs_status";--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "stop_reason" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "reserved_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "spent_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "token_usage" ADD COLUMN "cache_read_input_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "token_usage" ADD COLUMN "cache_write_input_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "token_usage" ADD COLUMN "guardrail_cache_read_input_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "token_usage" ADD COLUMN "guardrail_cache_write_input_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_idempotency_keys_user_endpoint_key" ON "idempotency_keys" USING btree ("user_id","endpoint","key");--> statement-breakpoint
CREATE INDEX "idx_idempotency_keys_expires_at" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_runs_running_user" ON "runs" USING btree ("user_id") WHERE status = 'running';--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "chk_runs_reserved_tokens" CHECK ("runs"."reserved_tokens" >= 0);--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "chk_runs_spent_tokens" CHECK ("runs"."spent_tokens" >= 0);--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "chk_runs_status" CHECK (status in ('running', 'awaiting_approval', 'completed', 'incomplete', 'refused', 'blocked', 'failed'));