import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const required = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: "key",
  GITHUB_WEBHOOK_SECRET: "secret",
  GCP_PROJECT: "my-ci",
  INSTANCE_TEMPLATE: "projects/my-ci/global/instanceTemplates/t",
  TASKS_QUEUE: "projects/my-ci/locations/us-central1/queues/q",
  INVOKER_SERVICE_ACCOUNT: "invoker@my-ci.iam.gserviceaccount.com",
};

describe("loadConfig", () => {
  it("defaults the pool to spillway and refuses fork PRs", () => {
    const c = loadConfig(required);
    expect(c).toMatchObject({ poolName: "spillway", runnerNamePrefix: "spillway-", allowForkPrs: false });
  });

  it("attaches the module's runner service account unless RUNNER_SERVICE_ACCOUNT is set", () => {
    expect(loadConfig(required).runnerServiceAccount).toBe("ci-runner-vm@my-ci.iam.gserviceaccount.com");
    expect(loadConfig({ ...required, RUNNER_SERVICE_ACCOUNT: "x@y.iam.gserviceaccount.com" }).runnerServiceAccount).toBe(
      "x@y.iam.gserviceaccount.com",
    );
  });

  it("derives the runner prefix from POOL_NAME unless set", () => {
    expect(loadConfig({ ...required, POOL_NAME: "acme" }).runnerNamePrefix).toBe("acme-");
    expect(loadConfig({ ...required, POOL_NAME: "acme", RUNNER_NAME_PREFIX: "acme-runner-" }).runnerNamePrefix).toBe("acme-runner-");
  });

  it("turns fork PRs on only for ALLOW_FORK_PRS=true", () => {
    expect(loadConfig({ ...required, ALLOW_FORK_PRS: "TRUE" }).allowForkPrs).toBe(true);
    expect(loadConfig({ ...required, ALLOW_FORK_PRS: "yes" }).allowForkPrs).toBe(false);
  });

  it.each(["Acme", "1pool", "pool_name", "a".repeat(41)])("rejects POOL_NAME %s", (name) => {
    expect(() => loadConfig({ ...required, POOL_NAME: name })).toThrow(/Invalid POOL_NAME/);
  });

  it("rejects an invalid RUNNER_NAME_PREFIX", () => {
    expect(() => loadConfig({ ...required, RUNNER_NAME_PREFIX: "Tp_" })).toThrow(/Invalid RUNNER_NAME_PREFIX/);
  });
});
