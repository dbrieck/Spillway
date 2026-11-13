// Entry point: wires real GitHub / Compute Engine / Cloud Tasks clients into the HTTP app.
import { randomBytes } from "node:crypto";
import { GceCompute } from "./compute.js";
import { loadConfig } from "./config.js";
import { GitHubAppClient } from "./github.js";
import type { Deps } from "./handlers.js";
import { googleOidcVerifier } from "./oidc.js";
import { createApp, log } from "./server.js";
import { CloudTasksQueue } from "./tasks.js";

function main(): void {
  const config = loadConfig();
  const deps: Deps = {
    config,
    github: new GitHubAppClient(config.githubAppId, config.githubAppPrivateKey),
    compute: new GceCompute(config.gcpProject, config.instanceTemplate, config.subnetworkPrefix, config.poolName, config.runnerServiceAccount),
    tasks: new CloudTasksQueue(config.tasksQueue, config.invokerServiceAccount, config.oidcAudience),
    now: () => new Date(),
    random: () => randomBytes(3).toString("hex"),
    log,
  };
  const port = Number(process.env.PORT ?? 8080);
  createApp(deps, googleOidcVerifier(config.oidcAudience, config.invokerServiceAccount)).listen(port, () =>
    log("ci-scaler listening", { port, maxRunners: config.maxRunners, repos: config.allowedRepos, pool: config.poolName }),
  );
}

main();
