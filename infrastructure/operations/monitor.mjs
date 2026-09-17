import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { promisify } from "node:util";
import { recordAudit, sendAlert, supabase } from "./common.mjs";

const exec = promisify(execFile);

export const httpTargets = [
  ["spaces", "https://spaces.community/", [200]],
  ["superadminko", "https://superadminko.spaces.community/", [200]],
  ["mcp", "https://mcp.spaces.community/health", [200]],
  ["data-plane", "https://spaces.community/api/data/health", [200]],
  ["outline", "https://outline.spaces.community/", [200, 302]],
  ["openseo", "https://openseo.spaces.community/", [200]],
];

export const containers = ["spaces-site", "spaces-provisioner", "spaces-billing", "spaces-data-plane", "spaces-mcp-gateway", "outline", "openseo"];

export function healthStatus(ok, latencyMs) {
  if (!ok) return "down";
  return latencyMs > 3000 ? "degraded" : "healthy";
}

async function checkHttp([service, url, accepted]) {
  const started = Date.now();
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(8000) });
    const latency = Date.now() - started;
    return { service, status: healthStatus(accepted.includes(response.status), latency), latency_ms: latency, details: { code: response.status } };
  } catch {
    return { service, status: "down", latency_ms: Date.now() - started, details: { code: "request_failed" } };
  }
}

async function checkContainer(name) {
  try {
    const { stdout } = await exec("docker", ["inspect", "--format", "{{.State.Status}}", name], { timeout: 5000 });
    const state = stdout.trim();
    return { service: `container:${name}`, status: state === "running" ? "healthy" : "down", latency_ms: null, details: { state } };
  } catch {
    return { service: `container:${name}`, status: "down", latency_ms: null, details: { state: "unavailable" } };
  }
}

async function checkDatabase() {
  const started = Date.now();
  try {
    await supabase("/rest/v1/rpc/operations_probe", { method: "POST", body: {} });
    return { service: "database", status: "healthy", latency_ms: Date.now() - started, details: { code: 200 } };
  } catch {
    return { service: "database", status: "down", latency_ms: Date.now() - started, details: { code: "probe_failed" } };
  }
}

async function checkDisk() {
  const disk = await statfs("/opt/spaces");
  const usedPercent = Math.round((1 - Number(disk.bavail) / Number(disk.blocks)) * 100);
  return { service: "disk", status: usedPercent >= 90 ? "down" : usedPercent >= 80 ? "degraded" : "healthy", latency_ms: null, details: { used_percent: usedPercent } };
}

async function checkBackup() {
  const rows = await supabase("/rest/v1/backup_runs?select=status,completed_at&status=eq.completed&order=completed_at.desc&limit=1");
  if (!rows?.length) return { service: "backup", status: "unconfigured", latency_ms: null, details: { code: "never_completed" } };
  const ageHours = Math.round((Date.now() - new Date(rows[0].completed_at).getTime()) / 3_600_000);
  return { service: "backup", status: ageHours > 36 ? "down" : ageHours > 26 ? "degraded" : "healthy", latency_ms: null, details: { age_hours: ageHours } };
}

async function storeCheck(check) {
  const previous = await supabase(`/rest/v1/operational_service_states?select=*&service=eq.${encodeURIComponent(check.service)}&limit=1`);
  const old = previous?.[0];
  const failures = check.status === "down" ? (old?.consecutive_failures || 0) + 1 : 0;
  const changed = Boolean(old && old.status !== check.status);
  await supabase("/rest/v1/operational_checks", { method: "POST", headers: { prefer: "return=minimal" }, body: check });
  await supabase("/rest/v1/operational_service_states?on_conflict=service", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: {
      service: check.service,
      status: check.status,
      consecutive_failures: failures,
      last_checked_at: new Date().toISOString(),
      last_changed_at: changed || !old ? new Date().toISOString() : old.last_changed_at,
      last_alerted_at: old?.last_alerted_at || null,
    },
  });
  if ((check.status === "down" && failures === 2) || (changed && old?.status === "down" && check.status !== "down")) {
    const recovered = check.status !== "down";
    const sent = await sendAlert(recovered ? `Spaces recovered: ${check.service}` : `Spaces incident: ${check.service}`,
      recovered ? `${check.service} is ${check.status} again.` : `${check.service} failed two consecutive health checks.`);
    await recordAudit(recovered ? "operations.service.recovered" : "operations.service.down", "service", check.service, { status: check.status, alert_sent: sent });
    await supabase(`/rest/v1/operational_service_states?service=eq.${encodeURIComponent(check.service)}`, {
      method: "PATCH", headers: { prefer: "return=minimal" }, body: { last_alerted_at: new Date().toISOString() },
    });
  }
}

export async function runMonitor() {
  const checks = await Promise.all([
    ...httpTargets.map(checkHttp),
    ...containers.map(checkContainer),
    checkDatabase(),
    checkDisk(),
    checkBackup(),
  ]);
  for (const check of checks) await storeCheck(check);
  console.log(JSON.stringify({ monitor: "ok", checks: checks.length, unhealthy: checks.filter((item) => item.status === "down").length }));
}

if (process.argv[1] === new URL(import.meta.url).pathname) runMonitor().catch((error) => {
  console.error(JSON.stringify({ monitor: "failed", code: "monitor_failed" }));
  process.exitCode = 1;
});
