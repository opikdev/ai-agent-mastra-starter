CREATE TABLE "rate_limits" (
	"key" text NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"reset_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_rate_limits" PRIMARY KEY("key")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"pending" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_runs" PRIMARY KEY("id"),
	CONSTRAINT "chk_runs_status" CHECK (status in ('running', 'awaiting_approval', 'completed', 'blocked', 'failed')),
	CONSTRAINT "chk_runs_pending" CHECK (("runs"."status" = 'awaiting_approval') = ("runs"."pending" is not null))
);
--> statement-breakpoint
CREATE TABLE "token_usage" (
	"user_id" text NOT NULL,
	"day" date NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_token_usage" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
CREATE INDEX "idx_rate_limits_reset_at" ON "rate_limits" USING btree ("reset_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_runs_open_thread" ON "runs" USING btree ("thread_id") WHERE status in ('running', 'awaiting_approval');--> statement-breakpoint
CREATE INDEX "idx_runs_user_id" ON "runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_token_usage_day" ON "token_usage" USING btree ("day");