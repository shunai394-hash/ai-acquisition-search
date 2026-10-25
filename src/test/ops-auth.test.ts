import assert from "node:assert/strict";
import test from "node:test";

const { GET: overview } = await import("../app/api/ops/overview/route");
const { GET: jobs } = await import("../app/api/ops/jobs/route");
const { GET: publishQueue } = await import("../app/api/cron/publish-queue/route");

test("ops overview and jobs reject anonymous requests", async () => {
  const overviewResponse = await overview(new Request("https://app.test/api/ops/overview"));
  const jobsResponse = await jobs(new Request("https://app.test/api/ops/jobs"));
  assert.equal(overviewResponse.status, 401);
  assert.equal(jobsResponse.status, 401);
});

test("the publish queue cron rejects a missing secret", async () => {
  const previous = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    const response = await publishQueue(new Request("https://app.test/api/cron/publish-queue"));
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.reason, "cron_secret_not_configured");
  } finally {
    if (previous) process.env.CRON_SECRET = previous;
  }
});
