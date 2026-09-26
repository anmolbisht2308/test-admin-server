# mockprep server

The API, background worker and shared types for mockprep, a mock-test platform for Indian
competitive exams. The student site and the admin panel are in
[test-admin-client](https://github.com/anmolbisht2308/test-admin-client).

| Package           | What it is                                       | Deployed to                                                                            |
| ----------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `apps/api`        | Express + Mongoose REST API (`GET /health`)      | Render web service                                                                     |
| `apps/worker`     | BullMQ workers (currently a `ping` job)          | inside the api on the free plan (`RUN_WORKER_IN_API`); own background worker when paid |
| `packages/types`  | `@mockprep/types`: shared TS types + Zod schemas | GitHub Release tarball                                                                 |
| `packages/config` | Shared tsconfig / eslint / prettier              | not deployed                                                                           |

## Local development

Requirements: Node 22.12+, pnpm (`corepack enable`), Docker.

```bash
corepack enable
pnpm install
docker compose up -d                       # MongoDB 7 on :27017, Redis 7 on :6379
cp apps/api/.env.example apps/api/.env
cp apps/worker/.env.example apps/worker/.env
pnpm --filter @mockprep/api seed           # exam templates + exams + SEED_ADMIN_EMAIL superadmin
pnpm dev                                   # types (watch) + api on :4000 + worker
curl localhost:4000/health                 # {"status":"ok","db":"up","redis":"up",...}
```

The worker logs `pong` on startup. That shows jobs flow through Redis end to end.

| Command          | What it does                                   |
| ---------------- | ---------------------------------------------- |
| `pnpm dev`       | everything in watch mode                       |
| `pnpm typecheck` | `tsc --noEmit` in every package                |
| `pnpm lint`      | eslint in every package + `prettier --check .` |
| `pnpm format`    | prettier write                                 |
| `pnpm test`      | vitest in every package                        |
| `pnpm build`     | compile every package to `dist/`               |

**Tests need Redis** at `TEST_REDIS_URL` (default `redis://localhost:6379/15`, so the docker
compose Redis works; db 15 is wiped between tests). CI runs a Redis service container.

**Tests and MongoDB.** API tests start an in-memory `mongod` through `mongodb-memory-server`. It
downloads a MongoDB binary the first time it runs. To use the docker compose Mongo instead (for
example offline, or when fastdl.mongodb.org is blocked), run:

```bash
TEST_MONGODB_URI=mongodb://localhost:27017/mockprep-test pnpm test
```

## Shared types (`@mockprep/types`)

The client repo installs `@mockprep/types` from a GitHub Release tarball. Both repos are public,
so no npm token is needed on Vercel or in CI.

1. Change the schemas in `packages/types/src`, then bump `version` in
   `packages/types/package.json`.
2. Merge to the default branch. The **Release @mockprep/types** workflow builds and tests the package, then
   attaches `mockprep-types-<v>.tgz` to a release named `types-v<v>`. It skips any version that
   has already been released. You can also start it by hand from the Actions tab.
3. In the client repo, point the dependency at the new URL:
   `https://github.com/anmolbisht2308/test-admin-server/releases/download/types-v<v>/mockprep-types-<v>.tgz`

To work across both repos locally, build the package here (`pnpm --filter @mockprep/types build`)
and link it into the client: run `pnpm link ../test-admin-server/packages/types` inside the
client app.

## Deploy (free setup)

While the project is being tested, everything runs on free plans. `render.yaml` is the free
setup. The paid setup for the commercial launch is `render.paid.yaml`, described in
[Moving to paid plans](#moving-to-paid-plans).

| Piece               | Free service                                | Limits to know                                                                                     |
| ------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| api + queue workers | Render **free** web service (one service)   | Sleeps after ~15 min idle; the first request then takes ~30–60 s. Queued jobs wait while it sleeps |
| Database            | MongoDB Atlas **M0**                        | 512 MB, no automatic backups                                                                       |
| Redis               | **Redis Cloud** free database               | 30 MB. Limited by storage, not by number of commands, which suits BullMQ                           |
| Question figures    | **Cloudflare R2** free tier (S3-compatible) | Cloudflare may ask for a card to turn R2 on; the free tier is not charged                          |
| Student login       | **Google sign-in** (free)                   | No phone OTP until SMS is paid for (`OTP_PROVIDER=console` only prints codes to the log)           |
| web + admin         | Vercel **Hobby** (see the client README)    | For non-commercial use; move to Pro before earning money                                           |

### 1. MongoDB Atlas (M0)

1. Create a free **M0** cluster. Pick an AWS Mumbai (ap-south-1) region so it is close to users.
2. **Database Access**: add a database user with a password.
3. **Network Access**: allow `0.0.0.0/0`. Render's free services have no fixed outbound IP.
4. Click **Connect → Drivers** and copy the SRV string. Add the database name, like this:
   `mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net/mockprep?retryWrites=true&w=majority`

### 2. Redis Cloud (free)

1. At redis.io/cloud, create a free database in the region closest to Singapore (for example
   AWS ap-south-1).
2. Copy the public endpoint and the default user's password. The `REDIS_URL` is
   `redis://default:PASSWORD@HOST:PORT`. If you turn on TLS, use `rediss://`.

### 3. Cloudflare R2 (question figures)

1. In Cloudflare, go to **R2 → Create bucket** (for example `mockprep-figures`).
2. **Public access**: in the bucket settings, turn on the public `r2.dev` URL (or connect a
   custom domain). That URL is `S3_PUBLIC_BASE_URL`, for example `https://pub-xxxx.r2.dev`.
3. **CORS policy** on the bucket: allow `PUT` from your admin site's URL, with allowed header
   `content-type`.
4. **R2 → Manage API tokens**: create a token with Object Read & Write on this bucket. It gives
   you an Access Key ID and a Secret Access Key.
5. Note your account id. The endpoint is `https://<account-id>.r2.cloudflarestorage.com`.

### 4. Render (free web service)

1. In Render, click **New → Blueprint** and select this repo. Render reads `render.yaml` and
   creates one free web service, `mockprep-api`, in Singapore. The queue workers run inside it
   (`RUN_WORKER_IN_API=true`).
2. Fill in the `sync: false` variables when asked (see the table below).
3. Deploy. On every start the api seeds the database (`SEED_ON_START=true`): it inserts missing
   templates and exams, and creates `SEED_ADMIN_EMAIL` once. Admin-panel edits are never
   overwritten.
4. Check it: `curl https://mockprep-api.onrender.com/health`. It returns 200 when Mongo and
   Redis are both up, and 503 otherwise. The logs should show `startup seed done`,
   `worker started` and `pong` (`source: api-embedded`).
5. Sign in to the admin panel with `SEED_ADMIN_EMAIL`. The first sign-in asks you to scan a QR
   code with an authenticator app (Google Authenticator, Authy, 1Password…).

| Variable                                                      | Value                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `MONGODB_URI`                                                 | Atlas M0 SRV string                                                                                    |
| `REDIS_URL`                                                   | Redis Cloud URL                                                                                        |
| `CORS_ORIGINS`                                                | web + admin URLs, comma-separated (browsers use the Next proxy, so this only matters for direct calls) |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`                     | first superadmin. Password: 12+ chars with upper, lower and a digit                                    |
| `GOOGLE_CLIENT_IDS`                                           | Google OAuth web client id (see the client README). This is how students sign in on the free setup     |
| `STORAGE_DRIVER`                                              | `s3` (R2 speaks the S3 protocol). Never `local` on Render: the disk is wiped on every deploy           |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_PUBLIC_BASE_URL` | R2: bucket name, `auto`, `https://<account-id>.r2.cloudflarestorage.com`, the public `r2.dev` URL      |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`                  | the R2 API token's keys (the S3 SDK reads these names)                                                 |

`render.yaml` also sets:

- `NODE_ENV=production`, `NODE_VERSION=22`, `LOG_LEVEL=info`, `TRUST_PROXY=2`. Requests pass
  through the Vercel rewrite and then Render's proxy.
- `RUN_WORKER_IN_API=true`, `WORKER_CONCURRENCY=2`, `SEED_ON_START=true`, `OTP_PROVIDER=console`.
- `JWT_SECRET` and `TOTP_ENCRYPTION_KEY`, generated by Render. **Never rotate
  `TOTP_ENCRYPTION_KEY`**: doing so locks out every admin's 2FA.

Optional api variables: `ACCESS_TOKEN_TTL_SEC` (900), `STUDENT_REFRESH_TTL_DAYS` (30),
`ADMIN_REFRESH_TTL_DAYS` (7), `STUDENT_MAX_DEVICES` (2), `RATE_LIMIT_WINDOW_MS`,
`RATE_LIMIT_MAX`, `APP_VERSION`. Without `APP_VERSION`, the short `RENDER_GIT_COMMIT` is used.

Every variable is validated at startup (`apps/api/src/env.ts`, `apps/worker/src/env.ts`). If one
is wrong, the process exits and prints the name of each bad variable.

### Moving to paid plans

Nothing in the code changes. You swap plans and env vars:

| Step        | Change                                                                                                                                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Render      | Rename `render.paid.yaml` to `render.yaml` and re-sync the Blueprint. You get a paid api service (seed runs as the pre-deploy step) plus a separate background worker. `RUN_WORKER_IN_API` and `SEED_ON_START` are off |
| Database    | Upgrade Atlas to M10 or higher for backups and more space                                                                                                                                                              |
| Redis       | Keep Redis Cloud on a paid plan, or use Upstash pay-as-you-go (`rediss://` URL)                                                                                                                                        |
| Figures     | Keep R2 (cheap: no bandwidth fees), or switch to AWS S3: remove `S3_ENDPOINT`, set a real region and IAM keys                                                                                                          |
| SMS OTP     | `OTP_PROVIDER=msg91` with `MSG91_AUTH_KEY` and `MSG91_TEMPLATE_ID` (needs a DLT-registered template containing `##otp##`)                                                                                              |
| web + admin | Vercel Pro                                                                                                                                                                                                             |

## Auth

| Who      | How                                                        | Endpoints                                      |
| -------- | ---------------------------------------------------------- | ---------------------------------------------- |
| Students | phone OTP (MSG91, or console in dev) or Google sign-in     | `/api/auth/otp/send`, `/otp/verify`, `/google` |
| Admins   | email + password (argon2), then TOTP (enrolment is forced) | `/api/admin/auth/login`, `/totp/verify`        |

- **Tokens.** Each sign-in returns a 15-minute JWT access token, sent as
  `Authorization: Bearer`. It also sets an httpOnly `SameSite=Strict` refresh cookie: `mp_rt`
  (path `/api/auth`) for students, `mp_art` (path `/api/admin/auth`) for admins.
- **Refresh.** `POST …/refresh` rotates the refresh token. A token that was already rotated out
  still works for 20 seconds, which covers racing tabs. After that, reusing it counts as theft
  and revokes the session. Refresh tokens are stored only as sha256 hashes, one session per
  device.
- **Device limit.** A student can have at most 2 active devices. Signing in on a third revokes
  the least recently used one.
- **Rate limits.** OTP send has a 30-second resend cooldown, a limit of 5 per phone per hour and
  20 per IP per hour. Each code allows 5 wrong attempts. Admin password tries are limited to 10
  per email per 15 minutes. All counters live in Redis.
- **Roles.** `student`, `superadmin`, `content`, `reviewer`, `support`, `finance`. Every admin
  role can read `/api/admin/*`, but only `superadmin` and `content` can change the catalogue.
  Every admin write is recorded in `auditLogs`.
- **Browsers never call Render directly.** Web and admin forward `/api/*` to the api through a
  Next.js rewrite, so the refresh cookies are first-party.

## Question bank, import and tests

- **Question bank.** Every question stores Markdown with LaTeX (`$…$`, `$$…$$`), optional Hindi
  fields, an answer (option indices, or a min–max range for integer/numeric questions), tags and
  an optional figure. Questions are versioned: if you change the content of a question used in a
  **published** test, a new version is created. The published test keeps the old one; draft tests
  switch to the new one.
- **Excel/CSV import** (`POST /api/admin/questions/import`, raw file body). Download the template
  from the admin Import page: it has the columns, examples and instructions. Each row is
  validated with the same rules as the editor. Bad rows come back with their row number and the
  reasons, and are skipped. Good rows are imported as approved. Rows already in the bank are
  imported but flagged `duplicate`. Use `?dryRun=1` to check a file without importing it.
- **Figures.** The admin editor asks the api for an upload URL and PUTs the image straight to it.
  - In dev, files go to `LOCAL_UPLOAD_DIR` and are served at `/api/files/…`.
  - In production they go to S3. The bucket needs a CORS rule allowing `PUT` from the admin
    origin with a `content-type` header, and public read (or CloudFront) for `S3_PUBLIC_BASE_URL`.
- **Tests.** A test copies its exam template when created (`templateSnapshot`), so later template
  edits never change it.
  - **Filling sections.** Pick questions from the bank, or fill by rule: count, topics, taxonomy
    nodes, difficulty mix, and "not used in the last N days".
  - **Publish checks.** Publishing is blocked until counts match the template and no question
    lacks an answer, is a draft, is a duplicate, or has the wrong option count.
  - **Preview.** "Preview as student" is built by the same serializer students will get, so it
    contains no answers or solutions.
  - **Student site.** Published tests appear as cards at `GET /api/exams/:slug/tests`.

## CI

`.github/workflows/ci.yml` runs on every PR and every push: install, typecheck, lint, test,
build.
