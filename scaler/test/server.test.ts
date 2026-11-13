import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import { verifyGitHubSignature } from "../src/signature.js";
import { makeDeps } from "./fakes.js";

const sign = (body: string, secret = "secret") => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("verifyGitHubSignature", () => {
  const body = Buffer.from('{"a":1}');
  it("accepts a correct signature and rejects everything else", () => {
    expect(verifyGitHubSignature(body, sign('{"a":1}'), "secret")).toBe(true);
    expect(verifyGitHubSignature(body, sign('{"a":1}', "other"), "secret")).toBe(false);
    expect(verifyGitHubSignature(body, "sha256=abc", "secret")).toBe(false);
    expect(verifyGitHubSignature(body, undefined, "secret")).toBe(false);
  });
});

describe("HTTP app", () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  async function start(tokenOk = true) {
    const fakes = makeDeps();
    const server = createApp(fakes.deps, async (h) => tokenOk && h === "Bearer good").listen(0);
    close = () => server.close();
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { ...fakes, url };
  }

  it("rejects webhooks with a bad signature", async () => {
    const { url, tasks } = await start();
    const res = await fetch(`${url}/webhook`, {
      method: "POST",
      headers: { "x-github-event": "ping", "x-hub-signature-256": "sha256=nope", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(tasks.tasks).toHaveLength(0);
  });

  it("accepts a signed workflow_job webhook and targets tasks at the request host", async () => {
    const { url, tasks } = await start();
    const body = JSON.stringify({
      action: "queued",
      repository: { full_name: "acme/app" },
      workflow_job: { id: 9, labels: ["self-hosted", "Linux", "X64"] },
    });
    const res = await fetch(`${url}/webhook`, {
      method: "POST",
      headers: { "x-github-event": "workflow_job", "x-hub-signature-256": sign(body), "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(202);
    expect(tasks.tasks[0]!.baseUrl).toBe(`https://${new URL(url).host}`);
  });

  it("requires an OIDC token on internal endpoints", async () => {
    const { url } = await start();
    expect((await fetch(`${url}/janitor`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${url}/janitor`, { method: "POST", headers: { authorization: "Bearer good" } })).status).toBe(200);
    const rec = await fetch(`${url}/reconcile`, {
      method: "POST",
      headers: { authorization: "Bearer bad", "content-type": "application/json" },
      body: "{}",
    });
    expect(rec.status).toBe(401);
  });
});
