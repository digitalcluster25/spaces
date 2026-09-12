const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS || 10000);
const adapters = {
  outline: {
    url: process.env.OUTLINE_PROVISION_URL || "https://outline.spaces.community/spaces-internal/provision",
    secret: process.env.OUTLINE_SERVICE_SECRET,
  },
  openseo: {
    url: process.env.OPENSEO_PROVISION_URL || "https://openseo.spaces.community/api/spaces/provision",
    secret: process.env.OPENSEO_SERVICE_SECRET,
  },
};

if (!supabaseUrl || !serviceRoleKey) throw new Error("Provisioner credentials are missing");

let stopping = false;
let lastMaintenanceAt = 0;

async function rpc(name, body = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${name} failed (${response.status})`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function callAdapter(job) {
  if (job.service_slug === "spaces") return { externalTenantId: job.project_id };
  const adapter = adapters[job.service_slug];
  if (!adapter?.url || !adapter.secret) throw new Error(`Adapter is not configured for ${job.service_slug}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(adapter.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adapter.secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        operation: job.operation,
        project: { id: job.project_id, name: job.project_name, slug: job.project_slug },
        owner: {
          userId: job.owner_user_id,
          email: job.owner_email,
          displayName: job.owner_display_name,
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${job.service_slug} adapter failed (${response.status})`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function processJob(job) {
  try {
    const result = await callAdapter(job);
    await rpc("complete_provisioning_job", {
      p_job_id: job.job_id,
      p_success: true,
      p_external_tenant_id: result.externalTenantId || null,
      p_error: null,
    });
    console.log(`completed ${job.service_slug}:${job.operation} ${job.job_id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Provisioning failed";
    await rpc("complete_provisioning_job", {
      p_job_id: job.job_id,
      p_success: false,
      p_external_tenant_id: null,
      p_error: message,
    });
    console.error(`failed ${job.service_slug}:${job.operation} ${job.job_id}: ${message}`);
  }
}

async function maintain() {
  if (Date.now() - lastMaintenanceAt < 60 * 60 * 1000) return;
  await rpc("enqueue_missing_provisioning_jobs");
  await rpc("purge_expired_projects");
  lastMaintenanceAt = Date.now();
}

async function run() {
  while (!stopping) {
    try {
      await maintain();
      const jobs = await rpc("claim_provisioning_jobs", { p_limit: 10 });
      for (const job of jobs || []) await processJob(job);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { stopping = true; });
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
