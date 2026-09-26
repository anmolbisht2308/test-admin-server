# Load test: answer saves

[k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) script for the hottest endpoint,
`PATCH /api/attempts/:id/answers`. 1,000 virtual students each send a batch every 5 s (what the
test screen does), about 200 requests/s. Pass: p95 < 300 ms and < 1 % errors.

Never run it against production: the seed creates students, a test and attempts.

```bash
# 1. api with a high rate limit (all virtual students share one IP)
RATE_LIMIT_MAX=1000000 RUN_WORKER_IN_API=true pnpm --filter @mockprep/api dev

# 2. fixtures: a published 100-question test + 1,000 students with attempts → loadtest/data.json
MONGODB_URI=mongodb://localhost:27017/mockprep REDIS_URL=redis://localhost:6379 \
JWT_SECRET=<the api's JWT_SECRET> LOADTEST_STUDENTS=1000 pnpm --filter @mockprep/api loadtest:seed

# 3. run
k6 run -e BASE_URL=http://localhost:4000 loadtest/save-answers.js
```

Options: `-e VUS=…`, `-e RAMP=30s`, `-e HOLD=2m`, `-e DATA=path/to/data.json`.
`data.json` holds access tokens: it is git-ignored.
