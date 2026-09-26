import { Schema, model, type Types } from "mongoose";

/** A student's saved question ("My revision list"). */
export interface BookmarkAttrs {
  userId: Types.ObjectId;
  questionId: Types.ObjectId;
  attemptId: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const bookmarkSchema = new Schema<BookmarkAttrs>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    questionId: { type: Schema.Types.ObjectId, ref: "Question", required: true },
    attemptId: { type: Schema.Types.ObjectId, ref: "Attempt", default: null },
  },
  { timestamps: true },
);
bookmarkSchema.index({ userId: 1, questionId: 1 }, { unique: true });
bookmarkSchema.index({ userId: 1, createdAt: -1 });

export const BookmarkModel = model<BookmarkAttrs>("Bookmark", bookmarkSchema, "bookmarks");
