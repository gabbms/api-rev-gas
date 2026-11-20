CREATE TABLE "customer_profiles" (
	"phone" text PRIMARY KEY NOT NULL,
	"name" text,
	"location" text,
	"number" text,
	"neighborhood" text,
	"city" text,
	"state" text,
	"complement" text,
	"landmark" text,
	"has_empty_cylinder" boolean,
	"revgas_customer_id" bigint,
	"last_sale_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
