import { createHash } from "node:crypto";

export function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export function safeCode(error) {
  const raw = error instanceof Error ? error.message : String(error || "unknown");
  if (/timeout|abort/i.test(raw)) return "timeout";
  if (/ENOSPC/i.test(raw)) return "disk_full";
  if (/pg_dump/i.test(raw)) return "database_dump_failed";
  if (/pg_restore/i.test(raw)) return "database_restore_verification_failed";
  if (/critical table/i.test(raw)) return "critical_table_verification_failed";
  if (/authenticate|decrypt/i.test(raw)) return "archive_authentication_failed";
  if (/checksum/i.test(raw)) return "storage_checksum_failed";
  if (/storage/i.test(raw)) return "storage_backup_failed";
  return "operation_failed";
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function supabase(path, { method = "GET", body, headers = {} } = {}) {
  const key = required("SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(`${required("SUPABASE_URL")}${path}`, {
    method,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`Supabase request failed (${response.status})`);
  return data;
}

export async function sendAlert(subject, text) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_EMAIL;
  if (!key || !to) return false;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: `${process.env.ALERT_SENDER_NAME || "Spaces Operations"} <${process.env.ALERT_FROM || "no-reply@spaces.community"}>`,
      to: [to],
      subject,
      text,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  return response.ok;
}

export async function recordAudit(action, targetType, targetId, metadata = {}) {
  await supabase("/rest/v1/audit_events", {
    method: "POST",
    headers: { prefer: "return=minimal" },
    body: { action, target_type: targetType, target_id: targetId, metadata },
  });
}
