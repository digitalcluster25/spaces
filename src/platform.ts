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
  subdomain: string;
  description: string | null;
  status: "planned" | "active" | "paused";
  base_url: string | null;
  mcp_url: string | null;
  auth_mode: string;
  is_core: boolean;
  capabilities: Record<string, unknown>;
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
  active_user_version_id: string | null;
};

export type HarnessVersion = {
  id: string;
  version: number;
  admin_config: Record<string, unknown>;
  git_revision: string | null;
  status: string;
  test_report: Record<string, unknown> | null;
  created_by: string;
  created_at: string;
  published_at: string | null;
};

export type HarnessPreview = {
  admin_config: Record<string, unknown>;
  user_config: Record<string, unknown>;
  effective_config: Record<string, unknown>;
  conflict_report: Array<{ field?: string; reason?: string }>;
  evaluation_report: {
    passed: boolean;
    evaluated_at: string;
    checks: Array<{ id: string; passed: boolean; message: string }>;
  };
};

export type ProjectHarnessVersion = {
  id: string;
  sequence: number;
  admin_version_id: string;
  admin_version: number;
  user_config: Record<string, unknown>;
  effective_config: Record<string, unknown>;
  conflict_report: Array<{ field?: string; reason?: string }>;
  evaluation_report: HarnessPreview["evaluation_report"];
  action: "initial" | "publish" | "admin_update" | "rollback" | "migration";
  source_version_id: string | null;
  created_by: string;
  author_name: string | null;
  author_email: string | null;
  created_at: string;
  is_active: boolean;
};

export type McpCredential = {
  id: string;
  project_id: string;
  name: string;
  scopes: string[];
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

export type KnowledgeDocument = {
  id: string;
  project_id?: string;
  title: string;
  content: string;
  service_slug: string;
  source_type: "manual" | "file" | "service" | "agent" | "outline";
  source_id: string | null;
  metadata: Record<string, unknown>;
  embedding_model: string | null;
  score?: number;
  created_at?: string;
  updated_at: string;
};

export type ProjectFile = {
  id: string;
  project_id: string;
  service_slug: string;
  object_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string | null;
  status: "uploading" | "active" | "deleted";
  created_at: string;
};

export type ProjectSecret = {
  id: string;
  project_id: string;
  name: string;
  kind: "api_key" | "token" | "password" | "credential" | "custom";
  service_slug: string | null;
  description: string | null;
  status: "active" | "disabled";
  version: number;
  rotated_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ProjectStorageSummary = {
  file_bytes: number;
  file_limit_bytes: number | null;
  vector_bytes: number;
  vector_limit_bytes: number | null;
  secret_count: number;
  secret_limit: number | null;
};

export type ProjectMember = {
  user_id: string;
  role: "owner" | "member";
  status: "active";
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
};

export type ProjectInvitation = {
  id: string;
  email: string;
  role: "member";
  status: "pending";
  delivery_status: "pending" | "sending" | "sent" | "failed";
  delivery_error: string | null;
  expires_at: string;
  created_at: string;
};

export type ProjectAccess = {
  role: "owner" | "member";
  members: ProjectMember[];
  invitations: ProjectInvitation[];
};

export type IncomingInvitation = {
  invitation_id: string;
  project_id: string;
  project_name: string;
  account_id: string;
  account_name: string;
  invited_by_name: string | null;
  expires_at: string;
};

export type Workspace = {
  profile: Profile;
  account: Account;
  accounts: Account[];
  accountRole: "owner" | "member";
  projects: Project[];
  services: Service[];
  projectServices: ProjectService[];
  mcpCredentials: McpCredential[];
  projectAccess: ProjectAccess | null;
  incomingInvitations: IncomingInvitation[];
  harness: HarnessState | null;
  harnessVersion: HarnessVersion | null;
  harnessHistory: ProjectHarnessVersion[];
  plans: Plan[];
  subscription: Subscription | null;
};

export type Plan = {
  id: string;
  code: string;
  name: string;
  price_cents: number;
  currency: string;
  billing_mode: string;
  billing_period: string | null;
  is_active: boolean;
  is_public: boolean;
  creem_test_product_id: string | null;
  creem_live_product_id: string | null;
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
  creem_customer_id: string | null;
  creem_subscription_id: string | null;
};

export type AccountLimitOverride = {
  account_id: string;
  key: string;
  value: number | null;
  reason: string | null;
  updated_at: string;
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

export type AuditMetaEvent = {
  id: number;
  action: string;
  period_start: string | null;
  period_end: string | null;
  deleted_count: number;
  digest: string;
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
  accountLimitOverrides: AccountLimitOverride[];
  jobs: ProvisioningJob[];
  audit: AuditEvent[];
  auditMeta: AuditMetaEvent[];
  harnessVersions: HarnessVersion[];
};

function requireClient() {
  if (!supabase) throw new Error("Supabase не подключен");
  return supabase;
}

export async function loadWorkspace(session: Session): Promise<Workspace> {
  const client = requireClient();
  const [profileResult, membershipResult, projectsResult, servicesResult, plansResult] = await Promise.all([
    client.from("profiles").select("*").eq("id", session.user.id).single(),
    client.from("account_memberships").select("account_id,role").eq("user_id", session.user.id).eq("status", "active"),
    client.from("projects").select("*").order("is_system", { ascending: false }).order("created_at"),
    client.from("spaces_services").select("*").eq("status", "active").order("sort_order"),
    client.from("plans").select("*").eq("is_active", true).eq("is_public", true).order("price_cents"),
  ]);

  const firstError = profileResult.error || membershipResult.error || projectsResult.error || servicesResult.error || plansResult.error;
  if (firstError) throw firstError;

  const accountIds = (membershipResult.data ?? []).map((item) => item.account_id);
  if (!accountIds.length) throw new Error("У пользователя нет активного аккаунта");
  const accountsResult = await client.from("accounts").select("*").in("id", accountIds).eq("status", "active").order("created_at");
  if (accountsResult.error) throw accountsResult.error;

  const accounts = (accountsResult.data ?? []) as Account[];
  const profile = profileResult.data as Profile;
  let tabAccountId: string | null = null;
  try { tabAccountId = window.sessionStorage.getItem(`spaces:active-account:${session.user.id}`); } catch { /* Browser storage can be disabled. */ }
  const account = accounts.find((item) => item.id === tabAccountId) ?? accounts[0];
  if (!account) throw new Error("Активный аккаунт недоступен");
  const accountRole = (membershipResult.data ?? []).find((item) => item.account_id === account.id)?.role as "owner" | "member";
  const projects = ((projectsResult.data ?? []) as Project[]).filter((project) => project.account_id === account.id);
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
  const [projectServicesResult, mcpCredentialsResult, subscriptionResult] = await Promise.all([
    projectIds.length
      ? client.from("project_services").select("*").in("project_id", projectIds)
      : Promise.resolve({ data: [], error: null }),
    projectIds.length
      ? client.from("mcp_credentials").select("id,project_id,name,scopes,expires_at,last_used_at,revoked_at,created_at").in("project_id", projectIds).order("created_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    client.from("account_subscriptions").select("*").eq("account_id", account.id).maybeSingle(),
  ]);
  if (projectServicesResult.error || mcpCredentialsResult.error || subscriptionResult.error) {
    throw projectServicesResult.error || mcpCredentialsResult.error || subscriptionResult.error;
  }

  const [harnessResult, harnessHistoryResult, projectAccessResult, incomingInvitationsResult] = await Promise.all([
    activeProjectId
      ? client.from("project_harness_settings").select("*").eq("project_id", activeProjectId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    activeProjectId
      ? client.rpc("list_project_harness_versions", { p_project_id: activeProjectId })
      : Promise.resolve({ data: [], error: null }),
    activeProjectId
      ? client.rpc("get_project_access", { p_project_id: activeProjectId })
      : Promise.resolve({ data: null, error: null }),
    client.rpc("list_my_project_invitations"),
  ]);
  if (harnessResult.error || harnessHistoryResult.error || projectAccessResult.error || incomingInvitationsResult.error) {
    throw harnessResult.error || harnessHistoryResult.error || projectAccessResult.error || incomingInvitationsResult.error;
  }
  const harness = harnessResult.data as HarnessState | null;
  const harnessVersionResult = harness?.active_version_id
    ? await client.from("harness_versions").select("*").eq("id", harness.active_version_id).maybeSingle()
    : { data: null, error: null };
  if (harnessVersionResult.error) throw harnessVersionResult.error;

  return {
    profile: { ...profile, active_project_id: activeProjectId },
    account,
    accounts,
    accountRole,
    projects,
    services: (servicesResult.data ?? []) as Service[],
    projectServices: (projectServicesResult.data ?? []) as ProjectService[],
    mcpCredentials: (mcpCredentialsResult.data ?? []) as McpCredential[],
    projectAccess: projectAccessResult.data as ProjectAccess | null,
    incomingInvitations: (incomingInvitationsResult.data ?? []) as IncomingInvitation[],
    harness,
    harnessVersion: harnessVersionResult.data as HarnessVersion | null,
    harnessHistory: (harnessHistoryResult.data ?? []) as ProjectHarnessVersion[],
    plans: (plansResult.data ?? []) as Plan[],
    subscription: subscriptionResult.data as Subscription | null,
  };
}

export function setActiveProjectForTab(accountId: string, projectId: string) {
  window.sessionStorage.setItem(`spaces:active-project:${accountId}`, projectId);
}

export function setActiveAccountForTab(userId: string, accountId: string) {
  window.sessionStorage.setItem(`spaces:active-account:${userId}`, accountId);
}

export async function createProject(accountId: string, input: {
  name: string;
  description?: string;
  logoUrl?: string;
  services: string[];
}) {
  const { error } = await requireClient().rpc("create_account_project", {
    p_account_id: accountId,
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

export async function createMcpCredential(projectId: string, name: string, expiresAt: string | null, scopes: string[]) {
  const { data, error } = await requireClient().rpc("create_mcp_credential", {
    p_project_id: projectId,
    p_name: name,
    p_scopes: scopes,
    p_expires_at: expiresAt,
  });
  if (error) throw error;
  return data as { id: string; name: string; token: string; scopes: string[]; expires_at: string | null; created_at: string };
}

export async function revokeMcpCredential(credentialId: string) {
  const { error } = await requireClient().rpc("revoke_mcp_credential", { p_credential_id: credentialId });
  if (error) throw error;
}

export async function createProjectInvitation(projectId: string, email: string) {
  const { error } = await requireClient().rpc("create_project_invitation", {
    p_project_id: projectId,
    p_email: email,
  });
  if (error) throw error;
}

export async function acceptProjectInvitation(invitationId: string) {
  const { data, error } = await requireClient().rpc("accept_project_invitation", {
    p_invitation_id: invitationId,
  });
  if (error) throw error;
  return data as { account_id: string; project_id: string };
}

export async function revokeProjectInvitation(invitationId: string) {
  const { error } = await requireClient().rpc("revoke_project_invitation", {
    p_invitation_id: invitationId,
  });
  if (error) throw error;
}

export async function removeProjectMember(projectId: string, userId: string) {
  const { error } = await requireClient().rpc("remove_project_member", {
    p_project_id: projectId,
    p_user_id: userId,
  });
  if (error) throw error;
}

export async function saveHarnessUserConfig(projectId: string, config: Record<string, unknown>) {
  const { error } = await requireClient().rpc("publish_harness_user_config", {
    p_project_id: projectId,
    p_user_config: config,
  });
  if (error) throw error;
}

export async function previewHarnessUserConfig(projectId: string, config: Record<string, unknown>) {
  const { data, error } = await requireClient().rpc("preview_harness_user_config", {
    p_project_id: projectId,
    p_user_config: config,
  });
  if (error) throw error;
  return data as HarnessPreview;
}

export async function rollbackHarnessUserConfig(projectId: string, versionId: string) {
  const { error } = await requireClient().rpc("rollback_harness_user_config", {
    p_project_id: projectId,
    p_version_id: versionId,
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
    client.from("account_limit_overrides").select("*").order("key"),
    client.from("provisioning_jobs").select("*").order("created_at", { ascending: false }).limit(100),
    client.from("audit_events").select("*").order("created_at", { ascending: false }).limit(200),
    client.from("audit_meta_events").select("*").order("created_at", { ascending: false }).limit(100),
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
    accountLimitOverrides: (results[7].data ?? []) as AccountLimitOverride[],
    jobs: (results[8].data ?? []) as ProvisioningJob[],
    audit: (results[9].data ?? []) as AuditEvent[],
    auditMeta: (results[10].data ?? []) as AuditMetaEvent[],
    harnessVersions: (results[11].data ?? []) as HarnessVersion[],
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

export async function createBillingCheckout(session: Session, accountId: string, planCode: string, seats: number) {
  const response = await fetch("/api/billing/checkout", {
    method: "POST",
    headers: { authorization: `Bearer ${session.access_token}`, "content-type": "application/json" },
    body: JSON.stringify({ accountId, planCode, seats }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.checkoutUrl) throw new Error(data?.error || "Не удалось создать оплату");
  return data.checkoutUrl as string;
}

export async function adminUpdatePlanBilling(planCode: string, testProductId: string, liveProductId: string) {
  const { error } = await requireClient().rpc("admin_update_plan_billing", {
    p_plan_code: planCode,
    p_creem_test_product_id: testProductId,
    p_creem_live_product_id: liveProductId,
  });
  if (error) throw error;
}

export async function adminSetAccountStatus(accountId: string, status: Account["status"]) {
  const { error } = await requireClient().rpc("admin_set_account_status", { p_account_id: accountId, p_status: status });
  if (error) throw error;
}

export async function adminSetAccountLimit(accountId: string, key: string, value: number | null, reason: string) {
  const { error } = await requireClient().rpc("admin_set_account_limit", {
    p_account_id: accountId,
    p_key: key,
    p_value: value,
    p_reason: reason || null,
  });
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
  const { error } = await requireClient().rpc("admin_save_service", {
    p_service_id: service.id || null,
    p_slug: service.slug,
    p_name: service.name,
    p_subdomain: service.subdomain,
    p_description: service.description,
    p_status: service.status,
    p_base_url: service.base_url,
    p_mcp_url: service.mcp_url,
    p_auth_mode: service.auth_mode,
    p_capabilities: service.capabilities,
    p_sort_order: service.sort_order,
  });
  if (error) throw error;
}

export async function adminDeleteAuditPeriod(periodStart: string, periodEnd: string) {
  const { error } = await requireClient().rpc("admin_delete_audit_period", {
    p_period_start: periodStart,
    p_period_end: periodEnd,
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

export async function loadProjectStorage(projectId: string) {
  const client = requireClient();
  const [knowledge, files, summary] = await Promise.all([
    client.from("project_knowledge_documents")
      .select("id,project_id,title,content,service_slug,source_type,source_id,metadata,embedding_model,created_at,updated_at")
      .eq("project_id", projectId)
      .order("updated_at", { ascending: false })
      .limit(100),
    client.from("project_files")
      .select("id,project_id,service_slug,object_path,file_name,mime_type,size_bytes,sha256,status,created_at")
      .eq("project_id", projectId)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(100),
    client.rpc("project_storage_summary", { p_project_id: projectId }),
  ]);
  const error = knowledge.error || files.error || summary.error;
  if (error) throw error;
  return {
    knowledge: (knowledge.data ?? []) as KnowledgeDocument[],
    files: (files.data ?? []) as ProjectFile[],
    summary: summary.data as ProjectStorageSummary,
  };
}

export async function searchProjectKnowledge(projectId: string, query: string) {
  const { data, error } = await requireClient().rpc("search_project_knowledge", {
    p_project_id: projectId,
    p_query: query,
    p_embedding: null,
    p_limit: 30,
  });
  if (error) throw error;
  return (data ?? []) as KnowledgeDocument[];
}

export async function saveProjectKnowledge(projectId: string, title: string, content: string, documentId?: string) {
  const { data, error } = await requireClient().rpc("upsert_project_knowledge", {
    p_project_id: projectId,
    p_id: documentId || null,
    p_title: title,
    p_content: content,
    p_source_type: "manual",
    p_source_id: null,
    p_service_slug: "spaces",
    p_metadata: {},
    p_embedding: null,
    p_embedding_model: null,
  });
  if (error) throw error;
  return data as KnowledgeDocument;
}

export async function deleteProjectKnowledge(projectId: string, documentId: string) {
  const { error } = await requireClient().rpc("delete_project_knowledge", { p_project_id: projectId, p_document_id: documentId });
  if (error) throw error;
}

async function sha256(file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function uploadProjectFile(projectId: string, file: File) {
  const client = requireClient();
  const reserved = await client.rpc("reserve_project_file", {
    p_project_id: projectId,
    p_file_name: file.name,
    p_mime_type: file.type || "application/octet-stream",
    p_size_bytes: file.size,
    p_service_slug: "spaces",
  });
  if (reserved.error) throw reserved.error;
  const row = reserved.data as ProjectFile;
  const uploaded = await client.storage.from("project-files").upload(row.object_path, file, { contentType: row.mime_type, upsert: false });
  if (uploaded.error) {
    await client.rpc("cancel_project_file", { p_file_id: row.id });
    throw uploaded.error;
  }
  const completed = await client.rpc("complete_project_file", { p_file_id: row.id, p_sha256: await sha256(file) });
  if (completed.error) {
    await client.storage.from("project-files").remove([row.object_path]);
    throw completed.error;
  }
  return completed.data as ProjectFile;
}

export async function openProjectFile(file: ProjectFile) {
  const { data, error } = await requireClient().storage.from("project-files").createSignedUrl(file.object_path, 60);
  if (error) throw error;
  window.open(data.signedUrl, "_blank", "noopener,noreferrer");
}

export async function deleteProjectFile(file: ProjectFile) {
  const client = requireClient();
  const removed = await client.storage.from("project-files").remove([file.object_path]);
  if (removed.error) throw removed.error;
  const { error } = await client.rpc("delete_project_file", { p_file_id: file.id });
  if (error) throw error;
}

async function dataPlane<T>(session: Session, path: string, options: RequestInit = {}) {
  const response = await fetch(`/api/data${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${session.access_token}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || "Сервис данных недоступен");
  return data as T;
}

export async function listProjectSecrets(session: Session, projectId: string) {
  const data = await dataPlane<{ secrets: ProjectSecret[] }>(session, `/secrets?projectId=${encodeURIComponent(projectId)}`);
  return data.secrets;
}

export async function saveProjectSecret(session: Session, input: {
  projectId: string;
  secretId?: string;
  name: string;
  kind: ProjectSecret["kind"];
  serviceSlug?: string;
  description?: string;
  value: string;
}) {
  const data = await dataPlane<{ secret: ProjectSecret }>(session, "/secrets", { method: "POST", body: JSON.stringify(input) });
  return data.secret;
}

export async function setProjectSecretStatus(session: Session, secretId: string, status: "active" | "disabled") {
  const data = await dataPlane<{ secret: ProjectSecret }>(session, `/secrets/${secretId}`, { method: "PATCH", body: JSON.stringify({ status }) });
  return data.secret;
}

export async function deleteProjectSecret(session: Session, secretId: string) {
  await dataPlane(session, `/secrets/${secretId}`, { method: "DELETE" });
}
