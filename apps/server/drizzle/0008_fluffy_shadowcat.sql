CREATE TABLE "inbound_events" (
	"id" text PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "channel" text DEFAULT 'simulated' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "channel_address" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "delivery_status" text;