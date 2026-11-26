CREATE TABLE "skill_files" (
	"skill_id" uuid NOT NULL,
	"path" text NOT NULL,
	"content" "bytea" NOT NULL,
	CONSTRAINT "skill_files_skill_id_path_pk" PRIMARY KEY("skill_id","path")
);
--> statement-breakpoint
ALTER TABLE "skill_files" ADD CONSTRAINT "skill_files_skill_id_catalog_items_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."catalog_items"("id") ON DELETE cascade ON UPDATE no action;