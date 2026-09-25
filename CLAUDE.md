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
It is published as `@mockprep/types` (GitHub Packages) and consumed by the client repo at a pinned
version. Never copy schemas into the client. For local cross-repo work, `pnpm link` the local
package into the client checkout.

A change to an API contract lands here first: update schema in packages/types → implement in api →
bump + publish `@mockprep/types` → then update the client repo.

## 3. Repo layout (this repo)

```
apps/
  api/        Node 22 + Express + TypeScript + Mongoose. REST API for web + admin.
              src/env.ts (Zod-validated env, fail fast), routes/, models/, services/, middleware/
  worker/     BullMQ workers on Redis for long jobs (PDF ingest, scoring, stats, invoices,
              notifications). One file per queue under src/jobs/.
packages/
  types/      @mockprep/types — shared TS types + Zod schemas (API inputs/outputs, exam templates,
              questions, tests, attempts). Built to dist/ and published.
  config/     @mockprep/config — shared tsconfig, eslint, prettier.
docker-compose.yml   local MongoDB 7 + Redis
render.yaml          api (web service) + worker (background worker)
```

Infra: MongoDB Atlas, Redis (Upstash), files on S3 (local-disk storage adapter in dev).
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
pnpm test             # vitest
pnpm build            # production build of all packages
pnpm --filter @mockprep/api <script>   # run a script in one package
```

(Commands become real in Phase 1; update this section if any change.)

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

**Data**

- Money is integer paise (`pricePaise`, `amountPaise`). Never floats, never rupees in storage.
- Times stored in UTC (`Date`); display conversion to Asia/Kolkata happens in the client.
- Question content is Markdown with LaTeX in `$...$` / `$$...$$`. Store it raw; the client renders
  it only through `@mockprep/ui` QuestionRenderer (sanitised). Never store pre-rendered HTML.

**Exam templates**

- Every exam difference — sections, question counts, timers, marking, option count, section
  switching, UI skin — comes from an exam template document. Never hard-code exam rules in scoring,
  validation or UI. Tests keep a `templateSnapshot` so later template edits never break old tests.

**Security**

- Correct answers and solutions are never sent to a student before that attempt is submitted.
  Student paper payloads are built by a dedicated serializer that strips them; test it.
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
| 1   | Setup: monorepos, CI/CD, deploys, /health |        |
| 2   | Auth + exam catalogue + exam templates    |        |
| 3   | Question bank + test builder              |        |
| 4   | PDF → test pipeline                       |        |
| 5   | Test engine                               |        |
| 6   | Results + analysis                        |        |
| 7   | Payments                                  |        |
| 8   | Live tests + notifications                |        |
| 9   | More exams + hardening + launch           |        |

**Current phase: 0 (complete) — next: Phase 1.**

## 9. Change log

- Phase 0: CLAUDE.md created. Decision: two monorepos (server / client), `@mockprep` scope,
  `@mockprep/types` owned and published by this repo.
