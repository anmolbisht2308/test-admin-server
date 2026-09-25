# mockprep server

The API, background worker and shared types for mockprep, a mock-test platform for Indian
competitive exams. The student site and the admin panel are in
[test-admin-client](https://github.com/anmolbisht2308/test-admin-client).

| Package           | What it is                                       | Deployed to              |
| ----------------- | ------------------------------------------------ | ------------------------ |
| `apps/api`        | Express + Mongoose REST API (`GET /health`)      | Render web service       |
| `apps/worker`     | BullMQ workers (currently a `ping` job)          | Render background worker |
| `packages/types`  | `@mockprep/types`: shared TS types + Zod schemas | GitHub Release tarball   |
| `packages/config` | Shared tsconfig / eslint / prettier              | not deployed             |

## Local development

Requirements: Node 22.12+, pnpm (`corepack enable`), Docker.

```bash
corepack enable
pnpm install
docker compose up -d                       # MongoDB 7 on :27017, Redis 7 on :6379
cp apps/api/.env.example apps/api/.env
cp apps/worker/.env.example apps/worker/.env
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

## Deploy

### 1. MongoDB Atlas

1. Create a cluster. Pick an AWS Mumbai (ap-south-1) region so it is close to users. M0 is fine to
   start with.
2. **Database Access**: add a database user with a password.
3. **Network Access**: allow `0.0.0.0/0`. Render's outbound IPs are not fixed on the starter plan.
   You can lock this down later with Render's static outbound IPs.
4. Click **Connect → Drivers** and copy the SRV string. Add the database name, like this:
   `mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net/mockprep?retryWrites=true&w=majority`

### 2. Upstash Redis

1. Create a Redis database in the `ap-south-1` region (or the closest one to Render Singapore).
2. Copy the **TLS** connection URL: `rediss://default:PASSWORD@xxx.upstash.io:6379`.
3. BullMQ keeps connections open and polls often. The free tier's request quota runs out quickly
   with a worker running, so use the pay-as-you-go or fixed plan in production.

### 3. Render (api + worker)

1. In Render, click **New → Blueprint** and select this repo. Render reads `render.yaml` and
   creates `mockprep-api` (web service) and `mockprep-worker` (background worker) in Singapore.
   Background workers need a paid instance.
2. Fill in the `sync: false` variables when asked:

| Variable       | api | worker | Value                                                                                                  |
| -------------- | :-: | :----: | ------------------------------------------------------------------------------------------------------ |
| `MONGODB_URI`  |  ✓  |        | Atlas SRV string                                                                                       |
| `REDIS_URL`    |  ✓  |   ✓    | Upstash `rediss://` URL                                                                                |
| `CORS_ORIGINS` |  ✓  |        | comma-separated web + admin URLs, e.g. `https://mockprep.vercel.app,https://mockprep-admin.vercel.app` |

`render.yaml` already sets these: `NODE_ENV=production`, `NODE_VERSION=22`, `LOG_LEVEL=info`,
`TRUST_PROXY=1` (api) and `WORKER_CONCURRENCY=5` (worker). Optional api variables:
`RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `APP_VERSION`. Without `APP_VERSION`, the short
`RENDER_GIT_COMMIT` is used. 3. Deploy. Render uses `GET /health` as the api health check. It returns 200 only when both Mongo
and Redis are up, and 503 otherwise. 4. Check it: `curl https://mockprep-api.onrender.com/health`. The worker's logs should show
`worker started` and `pong`. 5. After you add the Vercel URLs for web and admin, update `CORS_ORIGINS` and redeploy.

Every variable is validated at startup (`apps/api/src/env.ts`, `apps/worker/src/env.ts`). If one
is wrong, the process exits and prints the name of each bad variable.

## CI

`.github/workflows/ci.yml` runs on every PR and every push: install, typecheck, lint, test,
build.
