CREATE TABLE "completion_relay_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mapping_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"binding_hash" text NOT NULL,
	"receipt" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "completion_relay_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_company_id" uuid NOT NULL,
	"destination_company_id" uuid NOT NULL,
	"source_issue_id" uuid NOT NULL,
	"destination_issue_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"owner_key_id" uuid NOT NULL,
	"binding" jsonb NOT NULL,
	"binding_hash" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "completion_relay_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mapping_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "completion_relay_inbox" ADD CONSTRAINT "completion_relay_inbox_mapping_id_completion_relay_mappings_id_fk" FOREIGN KEY ("mapping_id") REFERENCES "public"."completion_relay_mappings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "completion_relay_inbox" ADD CONSTRAINT "completion_relay_inbox_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "completion_relay_inbox" ADD CONSTRAINT "completion_relay_inbox_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "completion_relay_mappings" ADD CONSTRAINT "completion_relay_mappings_source_company_id_companies_id_fk" FOREIGN KEY ("source_company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "completion_relay_mappings" ADD CONSTRAINT "completion_relay_mappings_destination_company_id_companies_id_fk" FOREIGN KEY ("destination_company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "completion_relay_mappings" ADD CONSTRAINT "completion_relay_mappings_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "completion_relay_mappings" ADD CONSTRAINT "completion_relay_mappings_destination_issue_id_issues_id_fk" FOREIGN KEY ("destination_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "completion_relay_outbox" ADD CONSTRAINT "completion_relay_outbox_mapping_id_completion_relay_mappings_id_fk" FOREIGN KEY ("mapping_id") REFERENCES "public"."completion_relay_mappings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "completion_relay_inbox_mapping_uq" ON "completion_relay_inbox" USING btree ("mapping_id");--> statement-breakpoint
CREATE INDEX "completion_relay_inbox_destination_idx" ON "completion_relay_inbox" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "completion_relay_mapping_key_uq" ON "completion_relay_mappings" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "completion_relay_outbox_mapping_uq" ON "completion_relay_outbox" USING btree ("mapping_id");--> statement-breakpoint
CREATE INDEX "completion_relay_outbox_due_idx" ON "completion_relay_outbox" USING btree ("state","next_attempt_at");