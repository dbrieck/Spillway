import express, { type Request, type Response } from "express";
import { handleJanitor, handleReconcile, handleRerun, handleWebhook, type Deps, type HandlerResult } from "./handlers.js";
import type { TokenVerifier } from "./oidc.js";
import { verifyGitHubSignature } from "./signature.js";

// Structured JSON lines so Cloud Logging picks up severity and fields.
export function log(msg: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ severity: "INFO", message: msg, ...fields }));
}

function logError(msg: string, err: unknown): void {
  console.error(JSON.stringify({ severity: "ERROR", message: msg, error: String(err) }));
}

export function createApp(deps: Deps, verifyToken: TokenVerifier): express.Express {
  const app = express();
  const baseUrl = (req: Request): string => deps.config.serviceUrl ?? `https://${req.get("host")}`;
  const send = (res: Response, r: HandlerResult) => res.status(r.status).json(r.body);

  const run = (label: string, fn: (req: Request) => Promise<HandlerResult>) => async (req: Request, res: Response) => {
    try {
      send(res, await fn(req));
    } catch (err) {
      logError(`${label} failed`, err);
      res.status(500).json({ result: "error" });
    }
  };

  const requireOidc = async (req: Request, res: Response, next: () => void) => {
    if (await verifyToken(req.get("authorization"))) return next();
    res.status(401).json({ result: "unauthorized" });
  };

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // Raw body: the HMAC must be computed over the exact bytes GitHub sent.
  app.post(
    "/webhook",
    express.raw({ type: "*/*", limit: "5mb" }),
    run("webhook", async (req) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!verifyGitHubSignature(raw, req.get("x-hub-signature-256"), deps.config.githubWebhookSecret)) {
        return { status: 401, body: { result: "bad-signature" } };
      }
      return handleWebhook(deps, req.get("x-github-event"), JSON.parse(raw.toString("utf8")), baseUrl(req));
    }),
  );

  app.post("/reconcile", requireOidc, express.json(), run("reconcile", (req) => handleReconcile(deps, req.body)));
  app.post("/rerun", requireOidc, express.json(), run("rerun", (req) => handleRerun(deps, req.body)));
  app.post("/janitor", requireOidc, run("janitor", (req) => handleJanitor(deps, baseUrl(req))));

  return app;
}
