ALTER TABLE "installation" ADD COLUMN "places_away_allowed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "seats" ADD COLUMN "works_while_away" boolean DEFAULT false NOT NULL;