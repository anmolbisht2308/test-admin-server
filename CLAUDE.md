# CLAUDE.md — mockprep server (test-admin-server)

Read this at the start of every session. Keep it under 200 lines and up to date.

## 1. Product

mockprep is a mock-test platform for Indian competitive exams. Students take full-length mocks in
an interface identical to the real exam and get score, rank, percentile and solutions.
Core differentiator: an admin uploads a question-paper PDF (+ optional answer key / solutions) and
the system creates a publish-ready test with minimal manual work (review only flagged questions).
Content is bilingual (English + Hindi). Most students are on low-end Android phones on slow networks.

Exam families:

- Banking: SBI PO / Clerk, IBPS PO / Clerk
- SSC: CGL, CHSL
- UPSC Prelims: GS Paper I + CSAT
- Defence: NDA, CDS
- Engineering: JEE Main, JEE Advanced

## 2. Two repos, one system

The product is split across two pnpm + Turborepo monorepos:

| Repo                              | Contains                                               | Hosting |
| --------------------------------- | ------------------------------------------------------ | ------- |
| **test-admin-server** (this repo) | apps/api, apps/worker, packages/types, packages/config | Render  |
| test-admin-client                 | apps/web, apps/admin, packages/ui, packages/config     | Vercel  |

`packages/types` lives **here** and is the single source of truth for shared TS types + Zod schemas.
It is released as a tarball on a GitHub Release `types-v<version>` (workflow
`release-types.yml`, runs on the default branch when `packages/types` changes and the version is
new). The client pins the release URL. Public repo → no npm token anywhere. Never copy schemas into
the client. For local cross-repo work, `pnpm link` the local package into the client checkout.

A change to an API contract lands here first: update schema in packages/types → implement in api →
bump `packages/types` version → merge (release is automatic) → update the URL in the client repo.

## 3. Repo layout (this repo)

```
apps/api/src/  Express 5 + Mongoose. env.ts (Zod, fail fast) · app.ts createApp(deps) · server.ts
  context.ts (AppContext for route factories) · middleware/ (asyncHandler, errorHandler, auth)
  lib/ (httpError, tokens, totp, cookies, dto mappers, studentPaper serializer)
  services/ (otp, sessions, google, rateLimit, audit, questions (versioning, approve),
    questionImport (exceljs), testBuilder (checks + rule fill), ingestQueue, scoreQueue)
  routes/ (auth, adminAuth, me, catalogue (+ /api/tests/:id), attempts (+ analysis, solutions,
    practice), studentContent (bookmarks, reports), storage, admin/* (+ reports))
  scripts/ (seed, loadtestSeed) · loadtest/ (k6 save-answers.js, README) at repo root
apps/api/test/ supertest vs createApp; helpers.ts (db, logins), factories.ts (seed, makeQuestion)
apps/worker/   BullMQ; processor per queue in src/jobs/, wired in src/runtime.ts. src/ingest/: PDF →
  test (pdf, textParser, keyParser, aiExtractor (Gemini, AiClient interface), sections, pipeline)
  test/fixtures: sample SBI/SSC/JEE PDFs + keys + scan (`pnpm --filter @mockprep/worker fixtures`)
packages/core  @mockprep/core (api + worker): models (…, upload, attempt, bookmark, report,
  questionStats), storage, flags, scoring, attemptStore, ranks, analysis, questionStats
packages/types @mockprep/types: shared Zod schemas + types (released, see §2)
packages/config shared tsconfig / eslint / prettier
docker-compose.yml (Mongo 7 + Redis) · render.yaml (FREE: one web service, worker embedded)
render.paid.yaml (paid: api + separate worker; rename to render.yaml for the commercial launch)
```

Infra (free): Render web, Atlas M0, Redis Cloud, R2, Brevo + Google. Paid later: see README.
Free switches: `RUN_WORKER_IN_API` (api starts `@mockprep/worker/runtime` in-process),
`SEED_ON_START` (seed at boot, no pre-deploy step). New queues go in apps/worker/src/runtime.ts.
External providers (OTP, storage, AI, payments, email, WhatsApp, push) always sit behind an
interface with a dev/console adapter.

## 4. Commands

Run from repo root (Turborepo fans out to every package):

```
pnpm install          # install all workspaces
docker compose up -d  # local MongoDB + Redis
pnpm dev              # api + worker in watch mode
pnpm typecheck        # tsc --noEmit everywhere
pnpm lint             # eslint + prettier --check
pnpm test             # vitest (api uses mongodb-memory-server)
pnpm build            # tsc → dist/ for every package
pnpm format           # prettier --write .
pnpm --filter @mockprep/api <script>   # run a script in one package
TEST_MONGODB_URI=mongodb://localhost:27017/mockprep-test pnpm test   # use docker Mongo instead
pnpm --filter @mockprep/api seed       # idempotent: templates, exams, SEED_ADMIN_EMAIL superadmin
```

Api tests need Redis at `TEST_REDIS_URL` (default redis://localhost:6379/15, wiped per test).

Env: copy `apps/*/.env.example` → `.env` (loaded by `tsx --env-file-if-exists`). Adding an env var =
add to that app's `env.ts` schema + `.env.example` + `render.yaml` + README table.

## 5. Conventions

**TypeScript**

- `strict: true`; no `any` (use `unknown` + narrowing). No `@ts-ignore` without a comment why.
- Every API input (body, query, params) is validated with a Zod schema imported from
  `@mockprep/types`. Response types come from the same package.

**API**

- Errors are always `{ error: string, details?: unknown }` with the correct HTTP status
  (400 validation, 401 unauthenticated, 403 forbidden, 404, 409 conflict, 429, 500).
- Every async route handler is wrapped in `asyncHandler` so errors reach the single error middleware.
  No try/catch that swallows errors or sends ad-hoc error shapes.
- Admin writes are recorded in `auditLogs` (actor, entity, entityId, action, diff, at).
- Long work (> ~1 s) goes to a BullMQ job in apps/worker, not the request.
- Routes live under `/api` (health also at `/health`). Admin routes under `/api/admin`, guarded by
  requireAuth + requireRole(ADMIN_ROLES); writes need `CONTENT_WRITERS` (superadmin, content).
- Responses are built with `lib/dto.ts` mappers (never send raw documents). Duplicate-key errors
  map to 409 in the error middleware.
- Auth: 15-min JWT (Bearer) + rotating refresh cookie per device (`mp_rt` /api/auth,
  `mp_art` /api/admin/auth), hashed in `sessions`; reuse after 20 s grace revokes the session.
  Browsers reach the api via the client apps' Next rewrites (TRUST_PROXY=2 on Render).
- Zod gotcha: `.partial()` keeps `.default()`s, so update schemas are built from default-free
  fields (see exam.ts). Questions/templates are saved whole (PUT), never partially.

**Data**

- Money is integer paise (`pricePaise`, `amountPaise`). Never floats, never rupees in storage.
- Times stored in UTC (`Date`); display conversion to Asia/Kolkata happens in the client.
- Question content is Markdown with LaTeX in `$...$` / `$$...$$`. Store it raw; the client renders
  it only through `@mockprep/ui` QuestionRenderer (sanitised). Never store pre-rendered HTML.
- Questions are versioned: `rootId` (= v1 id), `version`, `isLatest`. Editing content fields of a
  question in a published test creates a new version (published tests keep the old id, drafts are
  repointed); tag-only edits stay in place. Bank/listing/builder use `isLatest: true` only.
- `hash` = sha1(normaliseForHash(stem, options)) for duplicates; "duplicate" flag on clash.
- PDF uploads: flags from core `contentFlags` (+ duplicate flags); unflagged → approved. Edits
  recompute flags of uploaded questions, approve clears them. Re-runs replace an upload's output.
- Files via core `storage.ts` (local driver: signed PUT `/api/storage/local/*`, served at
  `/api/files/*`; s3 driver: presigned PUT). Production must use s3 (Render disk is ephemeral).
- Attempts: live state in Redis hash `attempt:{id}` (meta + `a:{questionId}`), never Mongo on
  the save path; latest client `at` wins; worker flushes dirty ids every 30 s and auto-submits
  overdue attempts; saves refused after deadline + 10 s; locked sections advance on the server
  clock. Scoring (core `scoring.ts`) runs in the worker `score` queue; answers never in papers.
- Ranks: Redis ZSET `rank:{testId}` of first attempts only (re-attempts, practice unranked);
  rebuilt from Mongo when missing. Answer-key fixes edit questions in place (no new version) +
  `rescore` job. 3 open reports → flag `reported`, left out of new papers (attempt.excluded).

**Exam templates**

- Every exam difference — sections, question counts, timers, marking, option count, section
  switching, UI skin — comes from an exam template document. Never hard-code exam rules in scoring,
  validation or UI. Tests keep a `templateSnapshot` so later template edits never break old tests.

**Security**

- Correct answers and solutions are never sent to a student before that attempt is submitted.
  Student payloads are built ONLY by `lib/studentPaper.ts` (allow-list copy; `studentQuestionSchema`
  is `.strict()`); tests assert no answer keys appear.
- Secrets only via env (validated in env.ts); `.env.example` lists every variable with no values.

**Client-facing constraints the API must respect**

- Student test screen must work on a 360px Android on slow 3G: keep paper payloads small,
  cacheable, and answer saves batched.

## 6. Definition of done (every task)

1. `pnpm typecheck`, `pnpm lint`, `pnpm test` pass.
2. Every new endpoint has at least one test (happy path + main failure/authorization case).
3. If structure, commands, env vars or conventions changed → CLAUDE.md updated (both repos if shared).
4. If `@mockprep/types` changed → version bumped, and the client repo change noted.
5. Conventional commit message (`feat(api): ...`, `fix(worker): ...`, `chore: ...`).

## 7. Do not

- Do not add a new library without stating why (and why an existing one doesn't do it).
- Do not substitute any part of the fixed stack (Express, Mongoose, Zod, BullMQ, pnpm, Turborepo).
- Do not put secrets, keys or real credentials in code, fixtures or commits.
- Do not send answers or solutions to the student client before submit.
- Do not hard-code exam patterns; read them from the template.
- Do not build features from later phases. If something later is needed, leave a `TODO(phase N)`.
- Do not use `any`, skip validation, or return a non-standard error shape.

## 8. Phases

Build order; each phase ends deployable and clickable. Start each in a fresh session in plan mode.

| #   | Phase                                     | Status |
| --- | ----------------------------------------- | ------ |
| 0   | Project context (CLAUDE.md)               | done   |
| 1   | Setup: monorepos, CI/CD, deploys, /health | done   |
| 2   | Auth + exam catalogue + exam templates    | done   |
| 3   | Question bank + test builder              | done   |
| 4   | PDF → test pipeline                       | done   |
| 5   | Test engine                               | done   |
| 6   | Results + analysis                        | done   |
| 7   | Payments                                  |        |
| 8   | Live tests + notifications                |        |
| 9   | More exams + hardening + launch           |        |

**Current phase: 6 (complete) — next: Phase 7.**

## 9. Change log

- 0–3 + free tier: monorepos, CI, auth, catalogue, audit, question bank, builder, embedded worker.
- 4: core pkg; `ingest` (Gemini / unpdf, key parser, flags); uploads api. types 0.5.0.
- 5: attempts, Redis store, flush/auto-submit, `score` queue; k6 p95 93 ms. types 0.6.1.
- 6: ranks, analysis, solutions, bookmarks, practice, reports, stats, re-score. types 0.7.0.
