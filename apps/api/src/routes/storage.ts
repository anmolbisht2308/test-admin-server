import { MAX_UPLOAD_BYTES, figurePresignInputSchema } from "@mockprep/types";
import express, { Router } from "express";
import { HttpError } from "../lib/httpError.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireRole } from "../middleware/auth.js";
import type { LocalStorage } from "@mockprep/core";
import { newFigureKey, type Storage } from "@mockprep/core";
import { CONTENT_WRITERS } from "./admin/common.js";

/** POST /api/admin/figures/presign — mounted inside the admin guard. */
export function adminFiguresRouter(storage: Storage): Router {
  const router = Router();
  router.post(
    "/presign",
    requireRole(...CONTENT_WRITERS),
    asyncHandler(async (req, res) => {
      const { contentType, size } = figurePresignInputSchema.parse(req.body);
      res.json(await storage.presignUpload(newFigureKey(contentType), contentType, size));
    }),
  );
  return router;
}

/**
 * Local driver only: PUT /api/storage/local/<key>?sig=… (like an S3 presigned URL, no auth
 * header) and GET /api/files/<key>.
 */
export function localStorageRouter(storage: LocalStorage): Router {
  const router = Router();
  router.put(
    "/storage/local/*key",
    // The signature pins the exact size; this is only the hard ceiling (question-paper PDFs).
    express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
    asyncHandler(async (req, res) => {
      const key = ([] as string[]).concat(req.params.key ?? []).join("/");
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const problem = storage.verifyUpload(key, req.query, req.get("content-type"), body.length);
      if (problem) throw new HttpError(403, `Upload rejected: ${problem}`);
      await storage.put(key, body);
      res.status(204).end();
    }),
  );
  router.use(
    "/files",
    express.static(storage.dir, {
      index: false,
      dotfiles: "deny",
      immutable: true,
      maxAge: "365d",
      fallthrough: true,
    }),
  );
  return router;
}
