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
  const projectIds = projects.map((project) => project.id);
  const projectServicesResult = projectIds.length
    ? await client.from("project_services").select("*").in("project_id", projectIds)
    : { data: [], error: null };
  if (projectServicesResult.error) throw projectServicesResult.error;

  const activeProjectId = (profileResult.data as Profile).active_project_id;
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
    profile: profileResult.data as Profile,
    account: accountResult.data as Account,
    projects,
    services: (servicesResult.data ?? []) as Service[],
    projectServices: (projectServicesResult.data ?? []) as ProjectService[],
    harness,
    harnessVersion: harnessVersionResult.data as HarnessVersion | null,
  };
}

export async function setActiveProject(projectId: string) {
  const client = requireClient();
  const { data: userResult, error: userError } = await client.auth.getUser();
  if (userError || !userResult.user) throw userError ?? new Error("Нужно войти");
  const { error } = await client.from("profiles").update({ active_project_id: projectId }).eq("id", userResult.user.id);
  if (error) throw error;
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
