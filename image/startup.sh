#!/usr/bin/env bash
# Boot-time entry point for a Spillway runner VM (systemd: ci-runner.service).
#
# Reads the single-use JIT runner config the scaler put in instance metadata, runs exactly one job,
# then powers the VM off. The VM has no permission to delete itself; the scaler's janitor deletes
# TERMINATED VMs, and GCE's max_run_duration deletes anything that outlives it.
#
# If no job starts within the idle timeout (another runner took it, or the job was cancelled),
# the runner is stopped and the VM powers off the same way.
set -uo pipefail

MD=http://metadata.google.internal/computeMetadata/v1/instance/attributes
RUNNER_DIR=/actions-runner

md() { curl -fsS -H "Metadata-Flavor: Google" "${MD}/$1"; }
log() { echo "ci-runner: $*"; } # ci-runner.service sends stdout to the journal and serial console
poweroff_vm() {
  log "powering off ($1)"
  sync
  systemctl poweroff --no-block
  exit 0
}

JIT="$(md runner-jitconfig)" || poweroff_vm "no runner-jitconfig metadata"
IDLE="$(md runner-idle-timeout-seconds 2>/dev/null || echo 900)"
case "${IDLE}" in '' | *[!0-9]*) IDLE=900 ;; esac

log "starting runner (idle timeout ${IDLE}s)"
cd "${RUNNER_DIR}" || poweroff_vm "missing ${RUNNER_DIR}"
sudo -u runner -H ./run.sh --jitconfig "${JIT}" &
RUN_PID=$!
unset JIT

# Lowest MemAvailable seen while the job runs = the job's peak memory use (sampled every 5 s, so a
# short spike can be missed). Logged at exit; the data that decides whether a job fits a smaller VM.
mem_kb() { awk -v k="$1:" '$1 == k { print $2 }' /proc/meminfo; }
mem_total_kb="$(mem_kb MemTotal)"
mem_min_avail_kb="$(mem_kb MemAvailable)"

# Idle watchdog: Runner.Worker only exists while a job is executing.
started=0
deadline=$(( $(date +%s) + IDLE ))
while kill -0 "${RUN_PID}" 2>/dev/null; do
  if pgrep -x Runner.Worker >/dev/null 2>&1; then
    if [ "${started}" -eq 0 ]; then log "job started"; fi
    started=1
    avail="$(mem_kb MemAvailable)"
    if [ -n "${avail}" ] && [ "${avail}" -lt "${mem_min_avail_kb:-0}" ]; then mem_min_avail_kb="${avail}"; fi
  elif [ "${started}" -eq 0 ] && [ "$(date +%s)" -ge "${deadline}" ]; then
    log "no job within ${IDLE}s; stopping runner"
    pkill -TERM -f Runner.Listener || true
    sleep 15
    pkill -KILL -f Runner.Listener || true
    break
  fi
  sleep 5
done
wait "${RUN_PID}" 2>/dev/null
if [ "${started}" -eq 1 ] && [ -n "${mem_total_kb}" ] && [ -n "${mem_min_avail_kb}" ]; then
  log "memory peak_used_mb=$(( (mem_total_kb - mem_min_avail_kb) / 1024 )) total_mb=$(( mem_total_kb / 1024 )) cpus=$(nproc)"
fi
poweroff_vm "runner exited (job started: ${started})"
