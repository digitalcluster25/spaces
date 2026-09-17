import assert from "node:assert/strict";

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) throw new Error("Missing Supabase production environment");

const headers = {
  apikey: serviceKey,
  authorization: `Bearer ${serviceKey}`,
  "content-type": "application/json",
};

async function rest(path, options = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, { ...options, headers: { ...headers, ...options.headers } });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.message || data?.error || `Supabase request failed (${response.status})`);
  return data;
}

const projects = await rest("projects?slug=in.(spaces,commercial-projects,nonprofit-projects)&select=id,slug,system_key");
assert.equal(projects.length, 3, "required Spaces projects are missing");
const root = projects.find((project) => project.system_key === "spaces-root");
assert(root, "Spaces root project is missing");

const settings = await rest(`project_harness_settings?project_id=in.(${projects.map((project) => project.id).join(",")})&select=*`);
assert.equal(settings.length, 3, "Harness settings are missing");
const rootSettings = settings.find((item) => item.project_id === root.id);
assert(rootSettings?.active_version_id, "root admin version is missing");
assert(rootSettings?.active_user_version_id, "root project version is missing");
assert.equal(rootSettings.offered_version_id, null, "root project must not have a pending admin version");

const [adminVersion] = await rest(`harness_versions?id=eq.${rootSettings.active_version_id}&select=id,version,admin_config,test_report,status`);
assert(adminVersion, "root admin version cannot be loaded");
assert.equal(adminVersion.status, "published");
assert.equal(adminVersion.test_report?.passed, true, "root admin version report must pass");

const serverReport = await rest("rpc/validate_harness_config", {
  method: "POST",
  body: JSON.stringify({ p_config: adminVersion.admin_config }),
});
assert.equal(serverReport?.passed, true, "root admin config fails server validation");

const history = await rest(`project_harness_versions?project_id=eq.${root.id}&select=id,sequence,admin_version_id,evaluation_report,created_at&order=sequence.desc`);
assert(history.length >= 2, "root Harness history is incomplete");
assert.equal(history[0].id, rootSettings.active_user_version_id, "root active history pointer is stale");
assert.equal(history[0].admin_version_id, adminVersion.id, "root effective version uses another admin layer");
assert.equal(history[0].evaluation_report?.passed, true, "root effective version fails evaluation");

const pending = settings.filter((item) => item.project_id !== root.id);
assert(pending.every((item) => item.offered_version_id === adminVersion.id), "non-root projects must receive the validated version as an offer");
assert(pending.every((item) => item.active_version_id !== adminVersion.id), "non-root projects must not be upgraded without owner approval");

console.log(JSON.stringify({
  harness: "ok",
  adminVersion: adminVersion.version,
  rootProjectVersion: history[0].sequence,
  checks: history[0].evaluation_report.checks.length,
  pendingOwnerApprovals: pending.length,
}));
