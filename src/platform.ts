import { createClient, type Session } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const authReady = Boolean(supabaseUrl && supabaseAnonKey);
export const supabase = authReady ? createClient(supabaseUrl!, supabaseAnonKey!) : null;

export type Profile = {
  id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  is_superadmin: boolean;
  active_project_id: string | null;
  trial_ends_at: string;
};

export type Account = {
  id: string;
  owner_id: string;
  name: string;
  slug: string;
  account_type: "personal" | "corporate";
  status: "active" | "suspended" | "archived";
};

export type Project = {
  id: string;
  account_id: string;
  owner_id: string;
  name: string;
  slug: string;
  description: string | null;
  logo_url: string | null;
  status: "active" | "archived" | "deleting";
  is_system: boolean;
  system_key: string | null;
  archived_at: string | null;
  purge_at: string | null;
  created_at: string;
  updated_at: string;
};

export type Service = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: "planned" | "active" | "paused";
  base_url: string | null;
  mcp_url: string | null;
  is_core: boolean;
  sort_order: number;
};

export type ProjectService = {
  id: string;
  project_id: string;
  service_id: string;
  status: "provisioning" | "ready" | "error" | "disabled" | "suspended" | "archived";
  external_tenant_id: string | null;
  external_tenant_name: string | null;
  last_error: string | null;
};

export type HarnessState = {
  project_id: string;
  user_config: Record<string, unknown>;
  conflict_report: Array<{ field?: string; reason?: string }>;
  active_version_id: string | null;
  offered_version_id: string | null;
};

export type HarnessVersion = {
  id: string;
  version: number;
  admin_config: Record<string, unknown>;
  status: string;
  test_report: Record<string, unknown> | null;
};

export type Workspace = {
  profile: Profile;
  account: Account;
  projects: Project[];
  services: Service[];
  projectServices: ProjectService[];
  harness: HarnessState | null;
  harnessVersion: HarnessVersion | null;
};

export type Plan = {
  id: string;
  code: string;
  name: string;
  price_cents: number;
  currency: string;
  billing_mode: string;
  is_active: boolean;
  is_public: boolean;
};

export type PlanLimit = {
  plan_id: string;
  key: string;
  value: number | null;
  unit: string;
  status: "active" | "reserve";
  description: string | null;
};

export type Subscription = {
  account_id: string;
  plan_id: string;
  status: string;
  seats: number;
  current_period_end: string | null;
  trial_ends_at: string | null;
};

export type ProvisioningJob = {
  id: string;
  project_service_id: string;
  operation: string;
  status: string;
  attempts: number;
  run_after: string;
  last_error: string | null;
  created_at: string;
};

export type AuditEvent = {
  id: number;
  account_id: string | null;
  project_id: string | null;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type AdminData = {
  profiles: Profile[];
  accounts: Account[];
  projects: Project[];
  services: Service[];
  plans: Plan[];
  limits: PlanLimit[];
  subscriptions: Subscription[];
  jobs: ProvisioningJob[];
  audit: AuditEvent[];
  harnessVersions: HarnessVersion[];
};

function requireClient() {
  if (!supabase) throw new Error("Supabase не подключен");
  return supabase;
}

export async function loadWorkspace(session: Session): Promise<Workspace> {
  const client = requireClient();
  const [profileResult, membershipResult, projectsResult, servicesResult] = await Promise.all([
    client.from("profiles").select("*").eq("id", session.user.id).single(),
    client.from("account_memberships").select("account_id").eq("user_id", session.user.id).eq("status", "active").limit(1).single(),
    client.from("projects").select("*").order("is_system", { ascending: false }).order("created_at"),
    client.from("spaces_services").select("*").eq("status", "active").order("sort_order"),
  ]);

  const firstError = profileResult.error || membershipResult.error || projectsResult.error || servicesResult.error;
  if (firstError) throw firstError;

  const accountResult = await client.from("accounts").select("*").eq("id", membershipResult.data.account_id).single();
  if (accountResult.error) throw accountResult.error;

  const projects = (projectsResult.data ?? []) as Project[];
  const profile = profileResult.data as Profile;
  const account = accountResult.data as Account;
  const activeProjects = projects.filter((project) => project.status === "active");
  let tabProjectId: string | null = null;
  try {
    tabProjectId = window.sessionStorage.getItem(`spaces:active-project:${account.id}`);
  } catch {
    // Browser storage can be disabled; the persisted profile remains the fallback.
  }
  const activeProjectId = activeProjects.some((project) => project.id === tabProjectId)
    ? tabProjectId
    : activeProjects.some((project) => project.id === profile.active_project_id)
      ? profile.active_project_id
      : activeProjects[0]?.id ?? null;
  const projectIds = projects.map((project) => project.id);
  const projectServicesResult = projectIds.length
    ? await client.from("project_services").select("*").in("project_id", projectIds)
    : { data: [], error: null };
  if (projectServicesResult.error) throw projectServicesResult.error;

  const harnessResult = activeProjectId
    ? await client.from("project_harness_settings").select("*").eq("project_id", activeProjectId).maybeSingle()
    : { data: null, error: null };
  if (harnessResult.error) throw harnessResult.error;
  const harness = harnessResult.data as HarnessState | null;
  const harnessVersionResult = harness?.active_version_id
    ? await client.from("harness_versions").select("*").eq("id", harness.active_version_id).maybeSingle()
    : { data: null, error: null };
  if (harnessVersionResult.error) throw harnessVersionResult.error;

  return {
    profile: { ...profile, active_project_id: activeProjectId },
    account,
    projects,
    services: (servicesResult.data ?? []) as Service[],
    projectServices: (projectServicesResult.data ?? []) as ProjectService[],
    harness,
    harnessVersion: harnessVersionResult.data as HarnessVersion | null,
  };
}

export function setActiveProjectForTab(accountId: string, projectId: string) {
  window.sessionStorage.setItem(`spaces:active-project:${accountId}`, projectId);
}

export async function createProject(input: {
  name: string;
  description?: string;
  logoUrl?: string;
  services: string[];
}) {
  const { error } = await requireClient().rpc("create_project", {
    project_name: input.name,
    project_description: input.description || null,
    project_logo_url: input.logoUrl || null,
    enabled_service_slugs: input.services,
  });
  if (error) throw error;
}

export async function updateProject(projectId: string, input: { name: string; description?: string; logoUrl?: string }) {
  const { error } = await requireClient().rpc("update_project", {
    p_project_id: projectId,
    project_name: input.name,
    project_description: input.description || null,
    project_logo_url: input.logoUrl || null,
  });
  if (error) throw error;
}

export async function archiveProject(projectId: string) {
  const { error } = await requireClient().rpc("archive_project", { p_project_id: projectId });
  if (error) throw error;
}

export async function restoreProject(projectId: string) {
  const { error } = await requireClient().rpc("restore_project", { p_project_id: projectId });
  if (error) throw error;
}

export async function setServiceEnabled(projectId: string, serviceSlug: string, enabled: boolean) {
  const { error } = await requireClient().rpc("set_project_service_enabled", {
    p_project_id: projectId,
    p_service_slug: serviceSlug,
    p_enabled: enabled,
  });
  if (error) throw error;
}

export async function createServiceTicket(projectId: string, serviceSlug: string) {
  const { data, error } = await requireClient().rpc("create_service_ticket", {
    p_project_id: projectId,
    p_service_slug: serviceSlug,
  });
  if (error) throw error;
  if (!data) throw new Error("Не удалось создать билет входа");
  return data as string;
}

export async function saveHarnessUserConfig(projectId: string, config: Record<string, unknown>) {
  const { error } = await requireClient().rpc("update_harness_user_config", {
    p_project_id: projectId,
    p_user_config: config,
  });
  if (error) throw error;
}

export async function acceptHarnessVersion(projectId: string) {
  const { error } = await requireClient().rpc("accept_harness_version", { p_project_id: projectId });
  if (error) throw error;
}

export async function loadAdminData(): Promise<AdminData> {
  const client = requireClient();
  const results = await Promise.all([
    client.from("profiles").select("*").order("created_at", { ascending: false }),
    client.from("accounts").select("*").order("created_at", { ascending: false }),
    client.from("projects").select("*").order("created_at", { ascending: false }),
    client.from("spaces_services").select("*").order("sort_order"),
    client.from("plans").select("*").order("price_cents"),
    client.from("plan_limits").select("*").order("key"),
    client.from("account_subscriptions").select("*"),
    client.from("provisioning_jobs").select("*").order("created_at", { ascending: false }).limit(100),
    client.from("audit_events").select("*").order("created_at", { ascending: false }).limit(200),
    client.from("harness_versions").select("*").order("version", { ascending: false }),
  ]);
  const failed = results.find((result) => result.error);
  if (failed?.error) throw failed.error;
  return {
    profiles: (results[0].data ?? []) as Profile[],
    accounts: (results[1].data ?? []) as Account[],
    projects: (results[2].data ?? []) as Project[],
    services: (results[3].data ?? []) as Service[],
    plans: (results[4].data ?? []) as Plan[],
    limits: (results[5].data ?? []) as PlanLimit[],
    subscriptions: (results[6].data ?? []) as Subscription[],
    jobs: (results[7].data ?? []) as ProvisioningJob[],
    audit: (results[8].data ?? []) as AuditEvent[],
    harnessVersions: (results[9].data ?? []) as HarnessVersion[],
  };
}

export async function adminUpdatePlanLimit(planCode: string, limit: Omit<PlanLimit, "plan_id">) {
  const { error } = await requireClient().rpc("admin_update_plan_limit", {
    p_plan_code: planCode,
    p_key: limit.key,
    p_value: limit.value,
    p_unit: limit.unit,
    p_status: limit.status,
    p_description: limit.description,
  });
  if (error) throw error;
}

export async function adminSetAccountStatus(accountId: string, status: Account["status"]) {
  const { error } = await requireClient().rpc("admin_set_account_status", { p_account_id: accountId, p_status: status });
  if (error) throw error;
}

export async function adminSetSubscription(accountId: string, planCode: string, status: string, seats: number) {
  const { error } = await requireClient().rpc("admin_set_subscription", {
    p_account_id: accountId,
    p_plan_code: planCode,
    p_status: status,
    p_seats: seats,
  });
  if (error) throw error;
}

export async function adminSaveService(service: Service) {
  const url = service.base_url ? new URL(service.base_url) : null;
  const { error } = await requireClient().rpc("admin_save_service", {
    p_service_id: service.id || null,
    p_slug: service.slug,
    p_name: service.name,
    p_subdomain: url?.hostname ?? service.slug,
    p_description: service.description,
    p_status: service.status,
    p_base_url: service.base_url,
    p_mcp_url: service.mcp_url,
    p_auth_mode: "spaces_ticket",
    p_capabilities: {},
    p_sort_order: service.sort_order,
  });
  if (error) throw error;
}

export async function adminRetryJob(jobId: string) {
  const { error } = await requireClient().rpc("admin_retry_provisioning_job", { p_job_id: jobId });
  if (error) throw error;
}

export async function adminPublishHarness(adminConfig: Record<string, unknown>, testReport: Record<string, unknown>, gitRevision?: string) {
  const { error } = await requireClient().rpc("publish_harness_version", {
    p_template_key: "spaces-core",
    p_admin_config: adminConfig,
    p_test_report: testReport,
    p_git_revision: gitRevision || null,
  });
  if (error) throw error;
}
