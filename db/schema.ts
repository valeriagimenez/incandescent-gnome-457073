import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";

export const courseMaterials = pgTable("course_materials", {
  id: text("id").primaryKey(),
  courseId: text("course_id").notNull(),
  teacherId: text("teacher_id").notNull(),
  title: text("title").notNull(),
  fileUrl: text("file_url").notNull(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  blobKey: text("blob_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("course_materials_course_idx").on(table.courseId)]);
