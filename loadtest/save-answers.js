// k6 load test: 1,000 students saving answers the way the test screen does (a batch every 5 s).
// Target: p95 < 300 ms, < 1% errors. See loadtest/README.md.
import { check, sleep } from "k6";
import http from "k6/http";

const data = JSON.parse(open(__ENV.DATA || "./data.json"));
const BASE = __ENV.BASE_URL || "http://localhost:4000";
const VUS = Number(__ENV.VUS || 1000);

export const options = {
  scenarios: {
    students: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: __ENV.RAMP || "30s", target: VUS },
        { duration: __ENV.HOLD || "2m", target: VUS },
      ],
      gracefulRampDown: "5s",
    },
  },
  thresholds: {
    "http_req_duration{name:save}": ["p(95)<300"],
    "http_req_failed{name:save}": ["rate<0.01"],
  },
};

export default function () {
  const student = data.students[(__VU - 1) % data.students.length];
  const now = Date.now();
  // 1–3 changed answers per sync, like a student working through questions.
  const answers = Array.from({ length: 1 + Math.floor(Math.random() * 3) }, (_, i) => ({
    questionId: data.questionIds[Math.floor(Math.random() * data.questionIds.length)],
    response: [Math.floor(Math.random() * 5)],
    state: Math.random() < 0.2 ? "answered_marked" : "answered",
    timeMs: Math.floor(Math.random() * 120000),
    at: now + i,
  }));
  const res = http.patch(
    `${BASE}/api/attempts/${student.attemptId}/answers`,
    JSON.stringify({ answers }),
    {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${student.token}` },
      tags: { name: "save" },
    },
  );
  check(res, { "saved (200)": (r) => r.status === 200 });
  sleep(5);
}
