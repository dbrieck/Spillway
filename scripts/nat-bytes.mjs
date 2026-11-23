#!/usr/bin/env node
// Cloud NAT bytes per runner VM over a time window: router.googleapis.com/nat/received_bytes_count
// summed over every region's NAT, divided by the scaler's `launched runner` log count (Spot and standard
// fallback launches both). NAT bills data processing in both directions, so sent bytes are shown too
// (they are small: uploads and requests). See docs/tuning.md (Cloud NAT data).
//
//   node scripts/nat-bytes.mjs --project my-ci-project --start 2026-11-20T00:00:00Z --end 2026-11-22T00:00:00Z
//
// Defaults: the last 48 hours, Cloud Run service ci-scaler (--service). Needs gcloud logged in with
// monitoring and logging read on the project, and Node 18 or later.
import { execSync } from "node:child_process";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, a, i, all) => (a.startsWith("--") ? [...pairs, [a.slice(2), all[i + 1]]] : pairs), []),
);
const project = args.project;
if (!project) {
  console.error("usage: nat-bytes.mjs --project <id> [--start <iso>] [--end <iso>] [--service ci-scaler]");
  process.exit(2);
}
const service = args.service ?? "ci-scaler";
const end = new Date(args.end ?? Date.now());
const start = new Date(args.start ?? end.getTime() - 48 * 3600 * 1000);
const token = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

async function natBytes(metric) {
  const q = new URLSearchParams({
    filter: `metric.type="router.googleapis.com/nat/${metric}"`,
    "interval.startTime": start.toISOString(),
    "interval.endTime": end.toISOString(),
    "aggregation.alignmentPeriod": "3600s",
    "aggregation.perSeriesAligner": "ALIGN_SUM",
    "aggregation.crossSeriesReducer": "REDUCE_SUM",
    "aggregation.groupByFields": "resource.label.region",
  });
  const res = await fetch(`https://monitoring.googleapis.com/v3/projects/${project}/timeSeries?${q}`, { headers });
  if (!res.ok) throw new Error(`monitoring ${res.status}: ${await res.text()}`);
  const byRegion = {};
  for (const ts of (await res.json()).timeSeries ?? []) {
    const region = ts.resource.labels.region;
    for (const p of ts.points) byRegion[region] = (byRegion[region] ?? 0) + Number(p.value.int64Value);
  }
  return byRegion;
}

async function launchedRunners() {
  const filter = [
    'resource.type="cloud_run_revision"',
    `resource.labels.service_name="${service}"`,
    'jsonPayload.message:"launched runner"',
    `timestamp>="${start.toISOString()}"`,
    `timestamp<"${end.toISOString()}"`,
  ].join(" AND ");
  let count = 0;
  let pageToken;
  do {
    const res = await fetch("https://logging.googleapis.com/v2/entries:list", {
      method: "POST",
      headers,
      body: JSON.stringify({ resourceNames: [`projects/${project}`], filter, pageSize: 1000, pageToken }),
    });
    if (!res.ok) throw new Error(`logging ${res.status}: ${await res.text()}`);
    const body = await res.json();
    count += (body.entries ?? []).length;
    pageToken = body.nextPageToken;
  } while (pageToken);
  return count;
}

const [received, sent, vms] = await Promise.all([natBytes("received_bytes_count"), natBytes("sent_bytes_count"), launchedRunners()]);
const total = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const gib = (b) => (b / 2 ** 30).toFixed(1);
console.log(`window   ${start.toISOString()} .. ${end.toISOString()}`);
for (const [region, bytes] of Object.entries(received).sort()) console.log(`received ${region.padEnd(12)} ${gib(bytes)} GiB`);
console.log(`received total       ${gib(total(received))} GiB`);
console.log(`sent total           ${gib(total(sent))} GiB`);
console.log(`VMs launched         ${vms}`);
if (vms > 0) console.log(`per VM               ${(total(received) / vms / 1e6).toFixed(0)} MB received, ${(total(sent) / vms / 1e6).toFixed(1)} MB sent`);
