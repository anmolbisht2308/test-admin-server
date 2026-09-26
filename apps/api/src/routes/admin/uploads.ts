import {
  UNFINISHED_UPLOAD_STATUSES,
  UploadModel,
  newStorageKey,
  type Storage,
  type UploadFile,
} from "@mockprep/core";
import { ExamModel, TestModel } from "@mockprep/core";
import {
  uploadCreateInputSchema,
  uploadPresignInputSchema,
  type StoredFileInput,
  type UploadConfigResponse,
  type UploadListResponse,
} from "@mockprep/types";
import { Router } from "express";
import { toUploadDto } from "../../lib/dto.js";
import { HttpError, conflictError, notFoundError } from "../../lib/httpError.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { getAuth, requireRole } from "../../middleware/auth.js";
import type { AppContext } from "../../context.js";
import { recordAudit } from "../../services/audit.js";
import { CONTENT_WRITERS, parseId } from "./common.js";

/** Queues one ingest run of an upload (BullMQ in production, a fake in tests). */
export type EnqueueIngest = (uploadId: string, run: number) => Promise<void>;

/** Public URL of a stored upload file (same rule as the storage drivers use for figures). */
function fileUrl(ctx: AppContext, key: string) {
  const base = ctx.env.STORAGE_DRIVER === "s3" ? ctx.env.S3_PUBLIC_BASE_URL : undefined;
  return base ? `${base.replace(/\/$/, "")}/${key}` : `/api/files/${key}`;
}

/** /api/admin/uploads — question-paper PDFs turned into draft tests by the worker. */
export function adminUploadsRouter(
  ctx: AppContext,
  storage: Storage,
  enqueue: EnqueueIngest,
): Router {
  const router = Router();
  const write = requireRole(...CONTENT_WRITERS);

  router.get("/config", (_req, res) => {
    const body: UploadConfigResponse = {
      ai: Boolean(ctx.env.GEMINI_API_KEY),
      model: ctx.env.GEMINI_API_KEY ? ctx.env.GEMINI_MODEL : null,
      chunkPages: ctx.env.CHUNK_PAGES,
    };
    res.json(body);
  });

  router.post(
    "/presign",
    write,
    asyncHandler(async (req, res) => {
      const { contentType, size } = uploadPresignInputSchema.parse(req.body);
      res.json(
        await storage.presignUpload(newStorageKey("uploads", contentType), contentType, size),
      );
    }),
  );

  router.get(
    "/",
    asyncHandler(async (_req, res) => {
      const uploads = await UploadModel.find().sort({ createdAt: -1 }).limit(100).lean();
      const body: UploadListResponse = {
        uploads: uploads.map((u) => {
          const { log: _log, ...rest } = toUploadDto(u);
          return rest;
        }),
      };
      res.json(body);
    }),
  );

  router.get(
    "/:id",
    asyncHandler(async (req, res) => {
      const upload = await UploadModel.findById(parseId(req.params.id, "Upload")).lean();
      if (!upload) throw notFoundError("Upload");
      res.json(toUploadDto(upload));
    }),
  );

  router.post(
    "/",
    write,
    asyncHandler(async (req, res) => {
      const input = uploadCreateInputSchema.parse(req.body);
      const exam = await ExamModel.findOne({ slug: input.examKey }).lean();
      if (!exam) throw new HttpError(400, "Unknown exam", { examKey: input.examKey });
      if (!exam.templateKeys.includes(input.templateKey)) {
        throw new HttpError(400, `${exam.shortName} does not use this template`, {
          templateKeys: exam.templateKeys,
        });
      }
      const file = (f: StoredFileInput): UploadFile => ({ ...f, url: fileUrl(ctx, f.key) });
      const upload = await UploadModel.create({
        title: input.title,
        examKey: input.examKey,
        templateKey: input.templateKey,
        files: {
          paper: file(input.files.paper),
          key: input.files.key ? file(input.files.key) : null,
          solutions: input.files.solutions ? file(input.files.solutions) : null,
        },
        runs: 1,
        createdBy: getAuth(req).userId,
      });
      await enqueue(upload.id, 1);
      const dto = toUploadDto(upload);
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "upload",
        entityId: dto.id,
        action: "create",
        after: dto,
      });
      res.status(201).json(dto);
    }),
  );

  router.post(
    "/:id/retry",
    write,
    asyncHandler(async (req, res) => {
      const upload = await UploadModel.findById(parseId(req.params.id, "Upload"));
      if (!upload) throw notFoundError("Upload");
      if (UNFINISHED_UPLOAD_STATUSES.includes(upload.status) && upload.status !== "queued") {
        throw conflictError("This upload is being processed right now");
      }
      if (await TestModel.exists({ uploadId: upload._id, status: "published" })) {
        throw conflictError("Its test is published. Unpublish it before re-running the upload.");
      }
      upload.runs += 1;
      upload.status = "queued";
      upload.progress = 0;
      upload.message = "Waiting to start";
      upload.error = null;
      await upload.save();
      await enqueue(upload.id, upload.runs);
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "upload",
        entityId: upload.id,
        action: "update",
        after: { retry: upload.runs },
      });
      res.json(toUploadDto(upload));
    }),
  );

  return router;
}
