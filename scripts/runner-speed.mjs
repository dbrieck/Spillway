#!/usr/bin/env node
// Compares how long the same jobs take on Spillway runners and on your other self-hosted runners.
//
//   node scripts/runner-speed.mjs --repo owner/name                       # last 7 days
//   node scripts/runner-speed.mjs --repo owner/name --days 14 --min 2 --prefix spillway-
//
// Needs an authenticated gh CLI. Durations are started_at to completed_at of successful jobs, so queue
// wait and VM boot are not included. Runners whose name starts with --prefix (the module's
// runner_name_prefix) are grouped as "Spillway"; other self-hosted runners are grouped by name minus a
// trailing -N, so a pool of runner-1, runner-2, ... shows as one column. GitHub-hosted runners are
// skipped. Only jobs that ran on Spillway at least --min times are shown.
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const repo = opt("repo", "");
if (!/^[^/]+\/[^/]+$/.test(repo)) {
  console.error("usage: runner-speed.mjs --repo owner/name [--days 7] [--min 1] [--max-runs 500] [--prefix spillway-]");
  process.exit(2);
}
const days = Number(opt("days", "7"));
const minSamples = Number(opt("min", "1"));
const maxRuns = Number(opt("max-runs", "500"));
const prefix = opt("prefix", "spillway-");
const OURS = "Spillway";

const gh = (path) =>
  JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));

const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
const runIds = [];
for (let page = 1; runIds.length < maxRuns; page++) {
  const { workflow_runs: runs } = gh(`repos/${repo}/actions/runs?status=completed&created=>=${since}&per_page=100&page=${page}`);
  if (runs.length === 0) break;
  runIds.push(...runs.map((r) => r.id));
}
runIds.length = Math.min(runIds.length, maxRuns);

const group = (runner) => {
  if (runner.startsWith(prefix)) return OURS;
  if (/^GitHub Actions \d+$/.test(runner)) return null; // GitHub-hosted
  return runner.replace(/-\d+$/, "");
};

const samples = new Map(); // job -> group -> seconds[]
let jobCount = 0;
for (const [i, id] of runIds.entries()) {
  process.stderr.write(`\rreading runs ${i + 1}/${runIds.length}`);
  // The default filter (latest attempt) keeps a re-run from counting the jobs it carried over twice.
  for (const j of gh(`repos/${repo}/actions/runs/${id}/jobs?per_page=100`).jobs) {
    if (j.conclusion !== "success" || !j.runner_name || !j.started_at || !j.completed_at) continue;
    const g = group(j.runner_name);
    if (!g) continue;
    const key = `${j.workflow_name} / ${j.name}`;
    if (!samples.has(key)) samples.set(key, new Map());
    const byGroup = samples.get(key);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push((new Date(j.completed_at) - new Date(j.started_at)) / 1000);
    jobCount++;
  }
}
process.stderr.write("\n");

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (s) => (s < 90 ? `${Math.round(s)}s` : `${(s / 60).toFixed(1)}m`);

const groups = [...new Set([...samples.values()].flatMap((m) => [...m.keys()]))].sort((a, b) =>
  a === OURS ? -1 : b === OURS ? 1 : a.localeCompare(b),
);
const rows = [...samples.entries()]
  .filter(([, m]) => (m.get(OURS)?.length ?? 0) >= minSamples)
  .sort(([a], [b]) => a.localeCompare(b));

console.log(`${repo}: ${jobCount} successful self-hosted jobs from ${runIds.length} runs since ${since}`);
console.log(`median run time (n = samples); vs ${OURS}: + means the other runner is slower\n`);
if (rows.length === 0) {
  console.log(`No job has ${minSamples} or more samples on runners named ${prefix}* yet.`);
  process.exit(0);
}
const width = Math.max(...rows.map(([k]) => k.length));
console.log(["job".padEnd(width), ...groups.map((g) => g.padEnd(24))].join("  "));
for (const [key, m] of rows) {
  const ours = m.has(OURS) ? median(m.get(OURS)) : undefined;
  const cells = groups.map((g) => {
    const v = m.get(g);
    if (!v) return "-".padEnd(24);
    const med = median(v);
    // A 0s median (started_at == completed_at) has no meaningful % delta; show the raw times only.
    const delta = g !== OURS && ours !== undefined && ours > 0 ? ` ${med >= ours ? "+" : ""}${Math.round(((med - ours) / ours) * 100)}%` : "";
    return `${fmt(med)} (n=${v.length})${delta}`.padEnd(24);
  });
  console.log([key.padEnd(width), ...cells].join("  "));
}
