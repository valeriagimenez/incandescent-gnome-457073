CREATE TABLE "course_materials" (
	"id" text PRIMARY KEY,
	"course_id" text NOT NULL,
	"teacher_id" text NOT NULL,
	"title" text NOT NULL,
	"file_url" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"blob_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "course_materials_course_idx" ON "course_materials" ("course_id");