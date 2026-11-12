ALTER TYPE "public"."seat_kind" ADD VALUE 'subscription-server';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "present_at" timestamp with time zone;