import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { FigurePresignResponse } from "@mockprep/types";
import { hmacSha256, safeEqualHex } from "./crypto.js";

/** The env fields storage needs (the api/worker Env objects satisfy this). */
export interface StorageConfig {
  STORAGE_DRIVER: "local" | "s3";
  LOCAL_UPLOAD_DIR: string;
  JWT_SECRET: string;
  S3_BUCKET?: string | undefined;
  S3_REGION?: string | undefined;
  S3_PUBLIC_BASE_URL?: string | undefined;
  S3_ENDPOINT?: string | undefined;
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
};
const PRESIGN_TTL_SEC = 600;

/** Object keys we generate; the local driver only accepts these (no path traversal). */
export const STORAGE_KEY_RE =
  /^(figures|uploads)\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.(png|jpg|webp|gif|pdf)$/;

/** figures/: question images. uploads/: question papers, keys and solutions (PDF or image). */
export function newStorageKey(
  prefix: "figures" | "uploads",
  contentType: string,
  now = new Date(),
): string {
  const ext = EXTENSIONS[contentType];
  if (!ext) throw new Error(`unsupported content type ${contentType}`);
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${prefix}/${now.getUTCFullYear()}/${month}/${randomUUID()}.${ext}`;
}

export const newFigureKey = (contentType: string, now = new Date()) =>
  newStorageKey("figures", contentType, now);

/** Upload target for browser uploads (presigned) and server-side writes (Phase 4 figures). */
export interface Storage {
  readonly driver: "local" | "s3";
  presignUpload(key: string, contentType: string, size: number): Promise<FigurePresignResponse>;
  put(key: string, body: Buffer, contentType: string): Promise<string>;
  /** Reads a stored object (the worker reads uploaded papers with this). */
  get(key: string): Promise<Buffer>;
}

/** Dev driver: files on disk, uploads go to a token-checked api route, served at /api/files/*. */
export class LocalStorage implements Storage {
  readonly driver = "local";
  constructor(
    readonly dir: string,
    private readonly secret: string,
    private readonly now: () => number = Date.now,
  ) {}

  private sign(key: string, contentType: string, size: number, exp: number) {
    return hmacSha256(this.secret, `upload:${key}:${contentType}:${size}:${exp}`);
  }

  presignUpload(key: string, contentType: string, size: number) {
    const exp = Math.floor(this.now() / 1000) + PRESIGN_TTL_SEC;
    const params = new URLSearchParams({
      ct: contentType,
      size: String(size),
      exp: String(exp),
      sig: this.sign(key, contentType, size, exp),
    });
    return Promise.resolve({
      uploadUrl: `/api/storage/local/${key}?${params.toString()}`,
      headers: { "content-type": contentType },
      fileUrl: `/api/files/${key}`,
    });
  }

  /** Checks a presigned local upload. Returns an error message or null. */
  verifyUpload(
    key: string,
    query: Record<string, unknown>,
    contentType: string | undefined,
    bytes: number,
  ): string | null {
    if (!STORAGE_KEY_RE.test(key)) return "invalid key";
    const { ct, size, exp, sig } = query;
    if (
      typeof ct !== "string" ||
      typeof size !== "string" ||
      typeof exp !== "string" ||
      typeof sig !== "string"
    )
      return "missing signature";
    if (Number(exp) < this.now() / 1000) return "upload link expired";
    if (!safeEqualHex(sig, this.sign(key, ct, Number(size), Number(exp))))
      return "invalid signature";
    if (contentType?.split(";")[0]?.trim() !== ct) return "content type does not match";
    if (bytes !== Number(size)) return "file size does not match";
    return null;
  }

  private resolve(key: string) {
    const target = path.resolve(this.dir, key);
    if (!target.startsWith(path.resolve(this.dir) + path.sep)) throw new Error("invalid key");
    return target;
  }

  async put(key: string, body: Buffer) {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
    return `/api/files/${key}`;
  }

  get(key: string) {
    return readFile(this.resolve(key));
  }
}

/** Production driver: browser PUTs straight to S3 with a presigned URL. */
export class S3Storage implements Storage {
  readonly driver = "s3";
  private readonly client: S3Client;
  constructor(
    private readonly bucket: string,
    region: string,
    private readonly publicBaseUrl: string,
    /** S3-compatible endpoint (Cloudflare R2, MinIO…). Omit for AWS S3. */
    endpoint?: string,
  ) {
    this.client = new S3Client({
      region,
      ...(endpoint ? { endpoint } : {}),
      // Browsers PUT to the presigned URL without computing checksums, so only add them when
      // an operation requires it (the SDK default would put checksum params in the URL).
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  async presignUpload(key: string, contentType: string, size: number) {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: size,
      CacheControl: "public, max-age=31536000, immutable",
    });
    return {
      uploadUrl: await getSignedUrl(this.client, command, {
        expiresIn: PRESIGN_TTL_SEC,
        signableHeaders: new Set(["content-type"]),
      }),
      headers: { "content-type": contentType },
      fileUrl: `${this.publicBaseUrl.replace(/\/$/, "")}/${key}`,
    };
  }

  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
    return `${this.publicBaseUrl.replace(/\/$/, "")}/${key}`;
  }

  async get(key: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`empty object ${key}`);
    return Buffer.from(await res.Body.transformToByteArray());
  }
}

export function createStorage(env: StorageConfig): Storage {
  if (env.STORAGE_DRIVER === "s3" && env.S3_BUCKET && env.S3_REGION && env.S3_PUBLIC_BASE_URL) {
    return new S3Storage(env.S3_BUCKET, env.S3_REGION, env.S3_PUBLIC_BASE_URL, env.S3_ENDPOINT);
  }
  return new LocalStorage(env.LOCAL_UPLOAD_DIR, env.JWT_SECRET);
}
