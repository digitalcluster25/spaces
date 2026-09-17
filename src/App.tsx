import React from "react";
import type { Session } from "@supabase/supabase-js";
import harnessDefaults from "../harness/defaults.json";
import { evaluateHarnessConfig, mergeHarnessConfig, type HarnessReport } from "../harness/evaluate.mjs";
import {
  Archive,
  ArrowRight,
  Bot,
  BrainCircuit,
  Check,
  ChevronDown,
  Command,
  Copy,
  CreditCard,
  ExternalLink,
  FileText,
  Files,
  Fingerprint,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Mail,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X,
  Activity,
  Database,
  ServerCog,
  Users,
} from "lucide-react";
import {
  acceptHarnessVersion,
  acceptProjectInvitation,
  adminPublishHarness,
  adminDeleteAuditPeriod,
  adminRetryJob,
  adminSaveService,
  adminSetAccountLimit,
  adminSetAccountStatus,
  adminSetSubscription,
  adminUpdatePlanBilling,
  adminUpdatePlanLimit,
  archiveProject,
  authReady,
  createProject,
  createBillingCheckout,
  createMcpCredential,
  createServiceTicket,
  createProjectInvitation,
  deleteProjectFile,
  deleteProjectKnowledge,
  deleteProjectSecret,
  loadWorkspace,
  loadProjectStorage,
  listProjectSecrets,
  loadAdminData,
  previewHarnessUserConfig,
  restoreProject,
  removeProjectMember,
  rollbackHarnessUserConfig,
  revokeMcpCredential,
  revokeProjectInvitation,
  saveHarnessUserConfig,
  saveProjectKnowledge,
  saveProjectSecret,
  searchProjectKnowledge,
  setActiveAccountForTab,
  setActiveProjectForTab,
  setServiceEnabled,
  setProjectSecretStatus,
  supabase,
  updateProject,
  uploadProjectFile,
  openProjectFile,
  type Project,
  type AdminData,
  type PlanLimit,
  type HarnessPreview,
  type ProjectHarnessVersion,
  type KnowledgeDocument,
  type ProjectFile,
  type ProjectSecret,
  type ProjectStorageSummary,
  type Service,
  type Workspace,
} from "./platform";
import { requiresSuperadminMfa } from "./security";

type AuthMode = "login" | "register" | "forgot";
type HarnessView = "admin" | "user" | "effective" | "history";

const harnessVersionsEnabled = import.meta.env.VITE_HARNESS_VERSIONS_ENABLED !== "false";
const projectDataEnabled = import.meta.env.VITE_PROJECT_DATA_ENABLED !== "false";

function useSession() {
  const [session, setSession] = React.useState<Session | null>(null);
  const [loading, setLoading] = React.useState(Boolean(supabase));

  React.useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setLoading(false);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  return { session, loading };
}

function useWorkspace(session: Session | null) {
  const [workspace, setWorkspace] = React.useState<Workspace | null>(null);
  const [loading, setLoading] = React.useState(Boolean(session));
  const [error, setError] = React.useState("");
  const sessionId = React.useRef<string | null>(null);

  const refresh = React.useCallback(async () => {
    if (!session) {
      sessionId.current = null;
      setWorkspace(null);
      setLoading(false);
      return;
    }
    if (sessionId.current !== session.user.id) {
      sessionId.current = session.user.id;
      setLoading(true);
    }
    setError("");
    try {
      setWorkspace(await loadWorkspace(session));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить аккаунт");
    } finally {
      setLoading(false);
    }
  }, [session]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  return { workspace, loading, error, refresh };
}

export function App() {
  const { session, loading: authLoading } = useSession();
  const path = window.location.pathname;
  const onAdminHost = window.location.hostname.startsWith("superadminko.");
  const mfaRequired = requiresSuperadminMfa(session?.user.email, path, window.location.hostname);
  const authMode: AuthMode | null =
    path === "/login" ? "login" : path === "/register" ? "register" : path === "/forgot" ? "forgot" : null;

  if (path === "/auth-bridge" && !onAdminHost) return <AuthBridge session={session} loading={authLoading} />;
  if (onAdminHost && !session) return <SuperadminSessionBridge />;

  if (session && mfaRequired) {
    return (
      <MfaBoundary session={session}>
        <RoutedApp session={session} authLoading={authLoading} path={path} authMode={authMode} />
      </MfaBoundary>
    );
  }

  return <RoutedApp session={session} authLoading={authLoading} path={path} authMode={authMode} />;
}

function RoutedApp({ session, authLoading, path, authMode }: { session: Session | null; authLoading: boolean; path: string; authMode: AuthMode | null }) {
  const needsWorkspace = window.location.hostname.startsWith("superadminko.") || ["/account", "/launch", "/superadmin"].includes(path);
  const workspaceState = useWorkspace(needsWorkspace ? session : null);
  return <AppContent session={session} authLoading={authLoading} workspaceState={workspaceState} path={path} authMode={authMode} />;
}

function AuthBridge({ session, loading }: { session: Session | null; loading: boolean }) {
  React.useEffect(() => {
    async function respond(event: MessageEvent) {
      if (event.origin !== "https://superadminko.spaces.community" || event.data?.type !== "spaces-auth-request") return;
      if (loading) return;
      if (!session || !supabase) return event.source?.postMessage({ type: "spaces-auth-response", status: "signed_out" }, { targetOrigin: event.origin });
      const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (error || data.currentLevel !== "aal2") return event.source?.postMessage({ type: "spaces-auth-response", status: "mfa_required" }, { targetOrigin: event.origin });
      event.source?.postMessage({ type: "spaces-auth-response", status: "ready", accessToken: session.access_token, refreshToken: session.refresh_token }, { targetOrigin: event.origin });
    }
    window.addEventListener("message", respond);
    return () => window.removeEventListener("message", respond);
  }, [loading, session]);
  return <StatePage loading title="Соединяем с Superadminko" text="Передаём защищённую сессию владельца." />;
}

function SuperadminSessionBridge() {
  const [message, setMessage] = React.useState("Получаем единую сессию Spaces.");
  const frame = React.useRef<HTMLIFrameElement>(null);

  React.useEffect(() => {
    const request = () => frame.current?.contentWindow?.postMessage({ type: "spaces-auth-request" }, "https://spaces.community");
    async function receive(event: MessageEvent) {
      if (event.origin !== "https://spaces.community" || event.data?.type !== "spaces-auth-response") return;
      if (event.data.status === "signed_out") return window.location.replace("https://spaces.community/login?redirect=%2Fsuperadmin%3Freturn_to%3Dhttps%253A%252F%252Fsuperadminko.spaces.community%252F");
      if (event.data.status === "mfa_required") return window.location.replace("https://spaces.community/superadmin?return_to=https%3A%2F%2Fsuperadminko.spaces.community%2F");
      if (event.data.status !== "ready" || !supabase) return;
      const { error } = await supabase.auth.setSession({ access_token: event.data.accessToken, refresh_token: event.data.refreshToken });
      if (error) setMessage(error.message);
    }
    window.addEventListener("message", receive);
    const timer = window.setInterval(request, 750);
    return () => { window.removeEventListener("message", receive); window.clearInterval(timer); };
  }, []);

  return <><StatePage loading title="Открываем Superadminko" text={message} /><iframe ref={frame} className="authBridgeFrame" title="Spaces session bridge" src="https://spaces.community/auth-bridge" onLoad={() => frame.current?.contentWindow?.postMessage({ type: "spaces-auth-request" }, "https://spaces.community")} /></>;
}

function AppContent({
  session,
  authLoading,
  workspaceState,
  path,
  authMode,
}: {
  session: Session | null;
  authLoading: boolean;
  workspaceState: ReturnType<typeof useWorkspace>;
  path: string;
  authMode: AuthMode | null;
}) {
  const header = session && workspaceState.workspace ? (
    <TenantBar session={session} workspace={workspaceState.workspace} onRefresh={workspaceState.refresh} />
  ) : (
    <PublicHeader session={session} loading={authLoading || (Boolean(session) && workspaceState.loading)} />
  );
  const adminRequested = window.location.hostname.startsWith("superadminko.") || path === "/superadmin";

  return (
    <main>
      {header}
      {adminRequested ? (
        <SuperadminPage session={session} workspace={workspaceState.workspace} />
      ) : path === "/launch" ? (
        <ServiceLaunchPage session={session} authLoading={authLoading} {...workspaceState} />
      ) : path === "/invite" ? (
        <InvitationPage session={session} authLoading={authLoading} />
      ) : path === "/account" ? (
        <AccountPage session={session} {...workspaceState} />
      ) : path === "/reset-password" ? (
        <ResetPasswordPage />
      ) : path === "/privacy" ? (
        <LegalPage type="privacy" />
      ) : path === "/terms" ? (
        <LegalPage type="terms" />
      ) : authMode ? (
        <AuthPage mode={authMode} />
      ) : (
        <Landing />
      )}
    </main>
  );
}

function MfaBoundary({ session, children }: { session: Session; children: React.ReactNode }) {
  const [verified, setVerified] = React.useState<boolean | null>(null);
  const finish = React.useCallback(() => {
    const returnTo = new URLSearchParams(window.location.search).get("return_to");
    if (returnTo === "https://superadminko.spaces.community/") window.location.replace(returnTo);
    else setVerified(true);
  }, []);

  React.useEffect(() => {
    if (!supabase) return;
    supabase.auth.mfa.getAuthenticatorAssuranceLevel().then(({ data, error }) => {
      if (!error && data.currentLevel === "aal2") finish();
      else setVerified(false);
    });
  }, [finish, session.access_token]);

  if (verified === null) return <StatePage loading title="Проверяем защиту аккаунта" text="Подтверждаем второй фактор." />;
  if (!verified) return <MfaSetup onVerified={finish} />;
  return <>{children}</>;
}

function MfaSetup({ onVerified }: { onVerified: () => void }) {
  const preparing = React.useRef(false);
  const [factorId, setFactorId] = React.useState("");
  const [qrCode, setQrCode] = React.useState("");
  const [secret, setSecret] = React.useState("");
  const [code, setCode] = React.useState("");
  const [mode, setMode] = React.useState<"loading" | "enroll" | "verify">("loading");
  const [message, setMessage] = React.useState("");
  const [working, setWorking] = React.useState(false);

  React.useEffect(() => {
    if (!supabase || preparing.current) return;
    preparing.current = true;
    async function prepare() {
      const { data, error } = await supabase!.auth.mfa.listFactors();
      if (error) {
        setMessage(error.message);
        setMode("verify");
        return;
      }
      const factor = data.totp.find((item) => item.status === "verified");
      if (factor) {
        setFactorId(factor.id);
        setMode("verify");
        return;
      }

      for (const pending of data.all.filter((item) => item.factor_type === "totp" && item.status === "unverified")) {
        const { error: removeError } = await supabase!.auth.mfa.unenroll({ factorId: pending.id });
        if (removeError) {
          setMessage(removeError.message);
          setMode("enroll");
          return;
        }
      }
      await enroll();
    }
    void prepare();
  }, []);

  async function enroll() {
    if (!supabase) return;
    setWorking(true);
    setMessage("");
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: "Spaces Superadmin" });
    setWorking(false);
    if (error) return setMessage(error.message);
    setFactorId(data.id);
    setQrCode(data.totp.qr_code);
    setSecret(data.totp.secret);
    setMode("verify");
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    if (!supabase || !factorId) return;
    setWorking(true);
    setMessage("");
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
    setWorking(false);
    if (error) return setMessage(error.message);
    onVerified();
  }

  return (
    <main className="securityGate">
      <div className="securityCard">
        <span className="securityIcon"><ShieldCheck size={22} /></span>
        <div><span className="sectionKicker">superadmin security</span><h1>Двухфакторная защита</h1><p>Для владельца Spaces второй фактор обязателен при каждом новом входе.</p></div>
        {mode === "loading" ? <div className="notice"><LoaderCircle className="spin" size={16} />Готовим защищённый вход</div> : mode === "enroll" ? (
          <button className="button buttonPrimary buttonFull" disabled={working} onClick={() => void enroll()}>{working ? "Создаём..." : "Настроить приложение-аутентификатор"}</button>
        ) : (
          <form className="mfaForm" onSubmit={verify}>
            {qrCode && <div className="qrBlock"><img src={qrCode} alt="QR-код для приложения-аутентификатора" /><div><strong>Отсканируйте QR-код</strong><p>Или введите ключ вручную:</p><code>{secret}</code></div></div>}
            <label>Код из приложения<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} required autoFocus /></label>
            <button className="button buttonPrimary buttonFull" disabled={working || code.length !== 6}>{working ? "Проверяем..." : "Подтвердить вход"}</button>
          </form>
        )}
        {message && <div className="notice errorNotice">{message}</div>}
      </div>
    </main>
  );
}

function Brand() {
  return (
    <a className="brand" href="/" aria-label="Spaces">
      <span className="brandMark"><Command size={18} /></span>
      <span>Spaces</span>
    </a>
  );
}

function PublicHeader({ session, loading }: { session: Session | null; loading: boolean }) {
  const userName = session?.user.user_metadata?.name || session?.user.user_metadata?.full_name || session?.user.email || "Пользователь";
  const avatarUrl = session?.user.user_metadata?.avatar_url as string | undefined;
  return (
    <header className="topbar">
      <Brand />
      <div className="topActions" aria-busy={loading}>
        {loading ? <span className="headerPlaceholder" /> : session ? (
          <>
            <Avatar name={userName} url={avatarUrl} />
            <a className="button buttonOutline shadowButton" href="/account">Профиль</a>
          </>
        ) : (
          <>
            <a className="button buttonGhost" href="/login">Войти</a>
            <a className="button buttonPrimary" href="/register">Начать</a>
          </>
        )}
      </div>
    </header>
  );
}

function Avatar({ name, url }: { name: string; url?: string | null }) {
  return (
    <span className="userAvatar" aria-label={name}>
      {url ? <img src={url} alt="" /> : name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function TenantBar({ session, workspace, onRefresh }: { session: Session; workspace: Workspace; onRefresh: () => Promise<void> }) {
  const [expanded, setExpanded] = React.useState(false);
  const activeProject = workspace.projects.find((project) => project.id === workspace.profile.active_project_id)
    ?? workspace.projects.find((project) => project.status === "active")
    ?? null;
  const projectServices = activeProject
    ? workspace.projectServices.filter((item) => item.project_id === activeProject.id && item.status === "ready")
    : [];

  async function changeProject(projectId: string) {
    setActiveProjectForTab(workspace.account.id, projectId);
    await onRefresh();
  }

  async function changeAccount(accountId: string) {
    setActiveAccountForTab(session.user.id, accountId);
    await onRefresh();
  }

  const name = workspace.profile.display_name || workspace.profile.email || "Пользователь";
  return (
    <header className={`tenantBar${expanded ? " expanded" : ""}`}>
      <div className="tenantMain">
        <Brand />
        <span className="tenantDivider" />
        <label className="accountSelectLabel"><span>Аккаунт</span><select value={workspace.account.id} onChange={(event) => void changeAccount(event.target.value)} aria-label="Активный аккаунт">{workspace.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select><ChevronDown size={14} /></label>
        <label className="projectSelectLabel">
          <span>Проект</span>
          <select
            value={activeProject?.id ?? ""}
            onChange={(event) => void changeProject(event.target.value)}
            disabled={!activeProject}
            aria-label="Активный проект"
          >
            {!activeProject && <option value="">Нет проектов</option>}
            {workspace.projects.filter((project) => project.status === "active").map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
          <ChevronDown size={14} />
        </label>
        <button className="tenantMenuButton" type="button" aria-label="Показать меню" onClick={() => setExpanded((value) => !value)}>
          {expanded ? <X size={18} /> : <MoreHorizontal size={18} />}
        </button>
      </div>
      <nav className="tenantServices" aria-label="Сервисы активного проекта">
        {projectServices.map((connection) => {
          const service = workspace.services.find((item) => item.id === connection.service_id);
          if (!service || service.is_core) return null;
          return <a key={service.id} href={serviceLaunchHref(activeProject!.id, service.slug)} target="_blank" rel="noopener noreferrer">{service.name}<ExternalLink size={13} /></a>;
        })}
        {workspace.profile.is_superadmin && <a href="https://superadminko.spaces.community" target="_blank" rel="noopener noreferrer">Superadminko<ExternalLink size={13} /></a>}
      </nav>
      <a className="tenantProfile" href="/account">
        <Avatar name={name} url={workspace.profile.avatar_url} />
        <span>{name}</span>
      </a>
    </header>
  );
}

function serviceLaunchHref(projectId: string, serviceSlug: string) {
  const params = new URLSearchParams({ project: projectId, service: serviceSlug });
  return `/launch?${params.toString()}`;
}

function ServiceLaunchPage({
  session,
  authLoading,
  workspace,
  loading,
  error,
}: {
  session: Session | null;
  authLoading: boolean;
  workspace: Workspace | null;
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
}) {
  const [launchError, setLaunchError] = React.useState("");
  const started = React.useRef(false);

  React.useEffect(() => {
    if (authLoading || loading || started.current) return;
    if (!session) {
      const redirect = window.location.pathname + window.location.search;
      window.location.replace(`/login?redirect=${encodeURIComponent(redirect)}`);
      return;
    }
    if (!workspace || error) return;

    const params = new URLSearchParams(window.location.search);
    const projectId = params.get("project") || "";
    const serviceSlug = params.get("service") || "";
    const project = workspace.projects.find((item) => item.id === projectId && item.status === "active");
    const service = workspace.services.find((item) => item.slug === serviceSlug && item.status === "active");
    const connection = workspace.projectServices.find((item) => item.project_id === projectId && item.service_id === service?.id);
    if (!project || !service?.base_url || connection?.status !== "ready") {
      setLaunchError("Сервис недоступен для выбранного проекта.");
      return;
    }

    started.current = true;
    void createServiceTicket(project.id, service.slug)
      .then((ticket) => {
        const next = service.slug === "outline" ? "/home" : "/";
        window.location.replace(`${service.base_url}/spaces-sso#ticket=${encodeURIComponent(ticket)}&next=${encodeURIComponent(next)}`);
      })
      .catch((cause) => {
        started.current = false;
        setLaunchError(cause instanceof Error ? cause.message : "Не удалось открыть сервис.");
      });
  }, [authLoading, error, loading, session, workspace]);

  if (error || launchError) return <StatePage title="Не удалось открыть сервис" text={launchError || error} action={<a className="button buttonOutline" href="/account">Вернуться к проектам</a>} />;
  return <StatePage loading title="Открываем сервис" text="Проверяем доступ к выбранному проекту." />;
}

function Landing() {
  return (
    <section className="hero">
      <div className="heroCopy">
        <div className="eyebrow"><Sparkles size={15} />единый аккаунт для экосистемы сервисов</div>
        <h1>Spaces управляет всеми сервисами проекта из одного AI-чата.</h1>
        <p>Один профиль, единые права и общий контекст для рабочих инструментов на субдоменах Spaces.</p>
        <div className="heroActions">
          <a className="button buttonPrimary buttonLarge" href="/register">Создать аккаунт<ArrowRight size={17} /></a>
          <a className="button buttonOutline buttonLarge" href="/login">Войти в Spaces</a>
        </div>
      </div>
      <div className="consolePanel" aria-label="AI workspace preview">
        <div className="consoleHeader"><span /><span /><span /></div>
        <div className="assistantCard">
          <span className="assistantIcon"><Bot size={20} /></span>
          <div><strong>AI-оператор Spaces</strong><p>Покажи просроченные задачи, проверь оплату и подготовь отчёт по сервисам.</p></div>
        </div>
        <div className="serviceGrid">
          {["CRM", "Analytics", "Docs", "Billing", "Support", "Tasks"].map((service) => <div className="serviceTile" key={service}><Check size={15} />{service}</div>)}
        </div>
        <div className="contextBar"><BrainCircuit size={17} /><span>Контекст найден в данных активного проекта</span></div>
      </div>
    </section>
  );
}

function AccountPage({
  session,
  workspace,
  loading,
  error,
  refresh,
}: {
  session: Session | null;
  workspace: Workspace | null;
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
}) {
  if (!authReady) return <StatePage title="Supabase не подключен" text="Не настроено подключение к базе данных." />;
  if (loading) return <StatePage loading title="Загружаем аккаунт" text="Проверяем проекты и сервисы." />;
  if (!session) return <StatePage title="Нужно войти" text="После входа откроются проекты и сервисы." action={<a className="button buttonPrimary" href="/login">Войти</a>} />;
  if (error || !workspace) return <StatePage title="Не удалось загрузить аккаунт" text={error || "Повторите попытку."} action={<button className="button buttonOutline" onClick={() => void refresh()}>Повторить</button>} />;
  return <ProjectDashboard session={session} workspace={workspace} refresh={refresh} />;
}

function InvitationPage({ session, authLoading }: { session: Session | null; authLoading: boolean }) {
  const [message, setMessage] = React.useState("");
  const started = React.useRef(false);
  const invitationId = new URLSearchParams(window.location.search).get("invitation") || "";
  const redirect = `/invite?invitation=${encodeURIComponent(invitationId)}`;

  React.useEffect(() => {
    if (authLoading || !session || !invitationId || started.current) return;
    started.current = true;
    void acceptProjectInvitation(invitationId)
      .then((result) => {
        setActiveAccountForTab(session.user.id, result.account_id);
        setActiveProjectForTab(result.account_id, result.project_id);
        window.location.replace("/account");
      })
      .catch((cause) => {
        started.current = false;
        setMessage(cause instanceof Error ? cause.message : "Не удалось принять приглашение");
      });
  }, [authLoading, invitationId, session]);

  if (!invitationId) return <StatePage title="Приглашение недоступно" text="В ссылке отсутствует идентификатор приглашения." action={<a className="button buttonOutline" href="/account">К проектам</a>} />;
  if (authLoading) return <StatePage loading title="Проверяем приглашение" text="Загружаем единую учётную запись Spaces." />;
  if (!session) return <StatePage title="Войдите в Spaces" text="Используйте тот email, на который отправлено приглашение." action={<div className="inlineActions"><a className="button buttonPrimary" href={`/login?redirect=${encodeURIComponent(redirect)}`}>Войти</a><a className="button buttonOutline" href={`/register?redirect=${encodeURIComponent(redirect)}`}>Создать аккаунт</a></div>} />;
  if (message) return <StatePage title="Не удалось принять приглашение" text={message} action={<a className="button buttonOutline" href="/account">К проектам</a>} />;
  return <StatePage loading title="Добавляем в проект" text="Проверяем email и права доступа." />;
}

function StatePage({ title, text, action, loading }: { title: string; text: string; action?: React.ReactNode; loading?: boolean }) {
  return <section className="statePage">{loading && <LoaderCircle className="spin" size={22} />}<h1>{title}</h1><p>{text}</p>{action}</section>;
}

type AdminTab = "overview" | "accounts" | "plans" | "services" | "harness" | "jobs" | "audit";

function SuperadminPage({ session, workspace }: { session: Session | null; workspace: Workspace | null }) {
  const [data, setData] = React.useState<AdminData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [tab, setTab] = React.useState<AdminTab>("overview");
  const [confirmation, setConfirmation] = React.useState<{ text: string; action: () => Promise<void> } | null>(null);
  const [working, setWorking] = React.useState(false);

  const refresh = React.useCallback(async () => {
    if (!session || !workspace?.profile.is_superadmin) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      setData(await loadAdminData());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить суперадминку");
    } finally {
      setLoading(false);
    }
  }, [session, workspace?.profile.is_superadmin]);

  React.useEffect(() => { void refresh(); }, [refresh]);

  async function runConfirmed() {
    if (!confirmation) return;
    setWorking(true);
    setError("");
    try {
      await confirmation.action();
      setConfirmation(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Операция не выполнена");
    } finally {
      setWorking(false);
    }
  }

  if (!session) return <StatePage title="Нужно войти" text="Суперадминка доступна только владельцу Spaces." action={<a className="button buttonPrimary" href="/login">Войти</a>} />;
  if (!workspace?.profile.is_superadmin) return <StatePage title="Доступ закрыт" text="У этой учётной записи нет прав суперадмина." />;
  if (loading && !data) return <StatePage loading title="Загружаем Superadminko" text="Проверяем аккаунты и системные настройки." />;
  if (!data) return <StatePage title="Не удалось загрузить данные" text={error} action={<button className="button buttonOutline" onClick={() => void refresh()}>Повторить</button>} />;

  const tabs: Array<[AdminTab, string, React.ReactNode]> = [
    ["overview", "Обзор", <Activity size={15} />],
    ["accounts", "Аккаунты", <Users size={15} />],
    ["plans", "Тарифы", <Database size={15} />],
    ["services", "Сервисы", <ServerCog size={15} />],
    ["harness", "Harness", <Settings2 size={15} />],
    ["jobs", "Provisioning", <LoaderCircle size={15} />],
    ["audit", "Аудит", <ShieldCheck size={15} />],
  ];

  return (
    <section className="adminShell">
      <div className="pageHeader"><div><span className="sectionKicker">owner control plane</span><h1>Superadminko</h1><p>Системные настройки Spaces. Все изменения записываются в аудит.</p></div><span className="badge dark">AAL2</span></div>
      <div className="adminTabs">{tabs.map(([key, label, icon]) => <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>{icon}{label}</button>)}</div>
      {error && <div className="notice errorNotice">{error}</div>}
      {tab === "overview" && <AdminOverview data={data} />}
      {tab === "accounts" && <AccountsAdmin data={data} confirm={(text, action) => setConfirmation({ text, action })} />}
      {tab === "plans" && <PlansAdmin data={data} confirm={(text, action) => setConfirmation({ text, action })} />}
      {tab === "services" && <ServicesAdmin data={data} confirm={(text, action) => setConfirmation({ text, action })} />}
      {tab === "harness" && <HarnessAdmin data={data} confirm={(text, action) => setConfirmation({ text, action })} />}
      {tab === "jobs" && <JobsAdmin data={data} confirm={(text, action) => setConfirmation({ text, action })} />}
      {tab === "audit" && <AuditAdmin data={data} confirm={(text, action) => setConfirmation({ text, action })} />}
      {confirmation && <ConfirmDialog title="Ты уверен, босс?" text={confirmation.text} confirm="Подтвердить" working={working} onClose={() => setConfirmation(null)} onConfirm={() => void runConfirmed()} />}
    </section>
  );
}

function AdminOverview({ data }: { data: AdminData }) {
  const stats = [
    ["Аккаунты", data.accounts.length],
    ["Проекты", data.projects.filter((project) => project.status === "active").length],
    ["Сервисы", data.services.filter((service) => service.status === "active").length],
    ["Ошибки provisioning", data.jobs.filter((job) => job.status === "failed").length],
  ];
  return <div className="statGrid">{stats.map(([label, value]) => <div className="stat" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>;
}

function AccountsAdmin({ data, confirm }: { data: AdminData; confirm: (text: string, action: () => Promise<void>) => void }) {
  return <div className="dataList">{data.accounts.map((account) => {
    const owner = data.profiles.find((profile) => profile.id === account.owner_id);
    const subscription = data.subscriptions.find((item) => item.account_id === account.id);
    const plan = data.plans.find((item) => item.id === subscription?.plan_id);
    return <AccountAdminRow key={account.id} account={account} owner={owner} planCode={plan?.code ?? "trial"} subscriptionStatus={subscription?.status ?? "trialing"} seats={subscription?.seats ?? 1} plans={data.plans} limits={data.limits} overrides={data.accountLimitOverrides.filter((item) => item.account_id === account.id)} confirm={confirm} />;
  })}</div>;
}

function AccountAdminRow({ account, owner, planCode, subscriptionStatus, seats, plans, limits, overrides, confirm }: { account: AdminData["accounts"][number]; owner?: AdminData["profiles"][number]; planCode: string; subscriptionStatus: string; seats: number; plans: AdminData["plans"]; limits: AdminData["limits"]; overrides: AdminData["accountLimitOverrides"]; confirm: (text: string, action: () => Promise<void>) => void }) {
  const [selectedPlan, setSelectedPlan] = React.useState(planCode);
  const [selectedStatus, setSelectedStatus] = React.useState(subscriptionStatus);
  const [seatCount, setSeatCount] = React.useState(seats);
  const saveText = "Изменить тариф аккаунта «" + account.name + "» на " + selectedPlan + ", статус " + selectedStatus + ", мест: " + seatCount + ".";
  const statusText = (account.status === "active" ? "Приостановить" : "Активировать") + " аккаунт «" + account.name + "».";
  return <article className="adminRow"><div><strong>{account.name}</strong><p>{owner?.email ?? account.slug}</p><div className="rowBadges"><span className="badge">{account.account_type}</span><span className={"status status-" + (account.status === "active" ? "ready" : "disabled")}>{account.status}</span></div></div><div><div className="adminControls"><select value={selectedPlan} onChange={(event) => setSelectedPlan(event.target.value)}>{plans.map((plan) => <option key={plan.id} value={plan.code}>{plan.name}</option>)}</select><select value={selectedStatus} onChange={(event) => setSelectedStatus(event.target.value)}><option value="trialing">trialing</option><option value="active">active</option><option value="past_due">past_due</option><option value="paused">paused</option></select><input type="number" min={1} value={seatCount} onChange={(event) => setSeatCount(Number(event.target.value))} aria-label="Места" /><button className="button buttonOutline" onClick={() => confirm(saveText, () => adminSetSubscription(account.id, selectedPlan, selectedStatus, seatCount))}>Сохранить тариф</button>{!owner?.is_superadmin && <button className="button buttonGhost" onClick={() => confirm(statusText, () => adminSetAccountStatus(account.id, account.status === "active" ? "suspended" : "active"))}>{account.status === "active" ? "Приостановить" : "Активировать"}</button>}</div><AccountLimitEditor account={account} limits={limits} overrides={overrides} confirm={confirm} /></div></article>;
}

function AccountLimitEditor({ account, limits, overrides, confirm }: { account: AdminData["accounts"][number]; limits: AdminData["limits"]; overrides: AdminData["accountLimitOverrides"]; confirm: (text: string, action: () => Promise<void>) => void }) {
  const available = Array.from(new Map(limits.map((limit) => [limit.key, limit])).values());
  const [key, setKey] = React.useState(available[0]?.key ?? "");
  const current = overrides.find((item) => item.key === key);
  const [value, setValue] = React.useState(current?.value?.toString() ?? "");
  const [reason, setReason] = React.useState(current?.reason ?? "");
  React.useEffect(() => { setValue(current?.value?.toString() ?? ""); setReason(current?.reason ?? ""); }, [current?.key, current?.value, current?.reason]);
  if (!available.length) return null;
  return <details className="accountLimits"><summary>Индивидуальные лимиты{overrides.length ? ` (${overrides.length})` : ""}</summary><div className="overrideEditor"><select value={key} onChange={(event) => setKey(event.target.value)}>{available.map((limit) => <option key={limit.key} value={limit.key}>{limit.description || limit.key}</option>)}</select><input type="number" min={0} value={value} placeholder="По тарифу" onChange={(event) => setValue(event.target.value)} /><input value={reason} placeholder="Причина изменения" onChange={(event) => setReason(event.target.value)} /><button className="button buttonOutline" onClick={() => confirm(`Изменить лимит ${key} для «${account.name}» на ${value || "значение тарифа"}.`, () => adminSetAccountLimit(account.id, key, value === "" ? null : Number(value), reason))}>Сохранить</button></div></details>;
}

function PlansAdmin({ data, confirm }: { data: AdminData; confirm: (text: string, action: () => Promise<void>) => void }) {
  return <div className="planColumns">{data.plans.map((plan) => <section className="planSection" key={plan.id}><div className="sectionHeader"><div><h2>{plan.name}</h2><p>{plan.price_cents ? "$" + (plan.price_cents / 100).toFixed(0) + " / " + (plan.billing_mode === "seat" ? "место" : "аккаунт") : "Системный тариф"}</p></div><code>{plan.code}</code></div>{["golden", "corporate"].includes(plan.code) && <PlanBillingEditor plan={plan} confirm={confirm} />}<div className="dataList">{data.limits.filter((limit) => limit.plan_id === plan.id).map((limit) => <LimitAdminRow key={limit.key} planCode={plan.code} limit={limit} confirm={confirm} />)}</div></section>)}</div>;
}

function PlanBillingEditor({ plan, confirm }: { plan: AdminData["plans"][number]; confirm: (text: string, action: () => Promise<void>) => void }) {
  const [testId, setTestId] = React.useState(plan.creem_test_product_id ?? "");
  const [liveId, setLiveId] = React.useState(plan.creem_live_product_id ?? "");
  return <div className="planBillingEditor"><label>Creem Test product ID<input value={testId} onChange={(event) => setTestId(event.target.value)} placeholder="prod_..." /></label><label>Creem Live product ID<input value={liveId} onChange={(event) => setLiveId(event.target.value)} placeholder="prod_..." /></label><button className="button buttonOutline" onClick={() => confirm(`Обновить привязку Creem для тарифа «${plan.name}».`, () => adminUpdatePlanBilling(plan.code, testId, liveId))}>Сохранить Creem</button></div>;
}

function LimitAdminRow({ planCode, limit, confirm }: { planCode: string; limit: PlanLimit; confirm: (text: string, action: () => Promise<void>) => void }) {
  const [value, setValue] = React.useState(limit.value?.toString() ?? "");
  const [status, setStatus] = React.useState<"active" | "reserve">(limit.status);
  const text = "Изменить лимит " + planCode + ":" + limit.key + " на " + (value || "без ограничений") + " (" + status + ").";
  return <div className="limitRow"><div><strong>{limit.description || limit.key}</strong><code>{limit.key}</code></div><input type="number" value={value} placeholder="∞" onChange={(event) => setValue(event.target.value)} /><span>{limit.unit}</span><select value={status} onChange={(event) => setStatus(event.target.value as "active" | "reserve")}><option value="active">active</option><option value="reserve">reserve</option></select><button className="button buttonOutline" onClick={() => confirm(text, () => adminUpdatePlanLimit(planCode, { ...limit, value: value === "" ? null : Number(value), status }))}>Сохранить</button></div>;
}

function ServicesAdmin({ data, confirm }: { data: AdminData; confirm: (text: string, action: () => Promise<void>) => void }) {
  const [creating, setCreating] = React.useState(false);
  const empty: Service = { id: "", slug: "", name: "", subdomain: "", description: "", status: "planned", base_url: null, mcp_url: null, auth_mode: "spaces_ticket", is_core: false, capabilities: {}, sort_order: 100 };
  return <div className="dataList"><div className="listToolbar"><button className="button buttonPrimary" onClick={() => setCreating(true)}><Plus size={15} />Добавить сервис</button></div>{creating && <ServiceAdminRow service={empty} confirm={confirm} onCancel={() => setCreating(false)} />}{data.services.map((service) => <ServiceAdminRow key={service.id} service={service} confirm={confirm} />)}</div>;
}

function ServiceAdminRow({ service, confirm, onCancel }: { service: Service; confirm: (text: string, action: () => Promise<void>) => void; onCancel?: () => void }) {
  const [draft, setDraft] = React.useState(service);
  const [capabilities, setCapabilities] = React.useState(JSON.stringify(service.capabilities ?? {}, null, 2));
  const [error, setError] = React.useState("");
  function save() {
    try {
      const parsed = JSON.parse(capabilities) as Record<string, unknown>;
      setError("");
      confirm("Сохранить системные настройки сервиса «" + draft.name + "».", async () => { await adminSaveService({ ...draft, capabilities: parsed }); onCancel?.(); });
    } catch { setError("Capabilities должны быть корректным JSON."); }
  }
  return <article className="adminRow serviceAdminRow"><div><strong>{service.name || "Новый сервис"}</strong><p>{service.slug || "Заполните реестр"}</p>{service.is_core && <span className="badge dark">core</span>}</div><div><div className="serviceAdminFields"><input value={draft.slug} disabled={service.is_core} onChange={(event) => setDraft({ ...draft, slug: event.target.value })} placeholder="slug" aria-label="Slug сервиса" /><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Название" aria-label="Название сервиса" /><input value={draft.subdomain} disabled={service.is_core} onChange={(event) => setDraft({ ...draft, subdomain: event.target.value })} placeholder="service.spaces.community" aria-label="Субдомен" /><input value={draft.base_url ?? ""} onChange={(event) => setDraft({ ...draft, base_url: event.target.value || null })} placeholder="Base URL" aria-label="URL сервиса" /><input value={draft.mcp_url ?? ""} onChange={(event) => setDraft({ ...draft, mcp_url: event.target.value || null })} placeholder="MCP URL" aria-label="MCP URL" /><input value={draft.auth_mode} onChange={(event) => setDraft({ ...draft, auth_mode: event.target.value })} placeholder="Режим авторизации" aria-label="Режим авторизации" /><input type="number" value={draft.sort_order} onChange={(event) => setDraft({ ...draft, sort_order: Number(event.target.value) })} aria-label="Порядок" /><select value={draft.status} disabled={service.is_core} onChange={(event) => setDraft({ ...draft, status: event.target.value as Service["status"] })}><option value="active">active</option><option value="paused">paused</option><option value="planned">planned</option></select><textarea value={capabilities} onChange={(event) => setCapabilities(event.target.value)} aria-label="Capabilities JSON" /><button className="button buttonOutline" onClick={save}>Сохранить</button>{onCancel && <button className="button buttonGhost" onClick={onCancel}>Отмена</button>}</div>{error && <div className="notice errorNotice">{error}</div>}</div></article>;
}

function HarnessAdmin({ data, confirm }: { data: AdminData; confirm: (text: string, action: () => Promise<void>) => void }) {
  const latest = data.harnessVersions[0];
  const [config, setConfig] = React.useState<Record<string, any>>(() => mergeHarnessConfig(harnessDefaults, latest?.admin_config));
  const [report, setReport] = React.useState<HarnessReport | null>(null);
  const getValue = (path: string) => path.split(".").reduce<any>((value, key) => value?.[key], config);
  function setValue(path: string, value: unknown) {
    setReport(null);
    setConfig((current) => {
      const next = structuredClone(current);
      const keys = path.split(".");
      const leaf = keys.pop()!;
      const parent = keys.reduce<Record<string, any>>((value, key) => value[key] ??= {}, next);
      parent[leaf] = value;
      return next;
    });
  }
  function preparePublish() {
    const nextReport = evaluateHarnessConfig(config);
    setReport(nextReport);
    if (!nextReport.passed) return;
    confirm(`Опубликовать проверенную версию Harness из Git ${__APP_REVISION__}. Проект Spaces получит её сразу, остальным пользователям обновление будет только предложено.`, () => adminPublishHarness(config, nextReport, __APP_REVISION__));
  }

  const flagGroups: Array<[string, string, Array<[string, string]>]> = [
    ["security", "Безопасность", [["tenant_isolation", "Изоляция проектов"], ["least_privilege", "Минимальные права"], ["secret_redaction", "Скрывать секреты"], ["destructive_action_confirmation", "Подтверждать опасные действия"], ["prompt_injection_defense", "Защита от prompt injection"], ["external_content_untrusted", "Внешний контент не доверенный"], ["data_minimization", "Минимизация данных"], ["audit_required", "Обязательный аудит"]]],
    ["quality", "Качество", [["require_acceptance_criteria", "Критерии приёмки"], ["require_tests", "Обязательные тесты"], ["require_production_check", "Проверка production"], ["require_source_verification", "Проверка источников"], ["disclose_uncertainty", "Сообщать неопределённость"], ["task_completion_required", "Доводить задачу до результата"]]],
    ["tooling", "Работа с инструментами", [["verify_after_write", "Проверять после изменений"], ["retry_transient_failures", "Повторять временные сбои"], ["record_audit_events", "Записывать аудит"], ["browser_visual_qa", "Визуальная проверка браузером"], ["protect_existing_changes", "Беречь существующие изменения"]]],
  ];

  return <section className="adminEditor"><div className="sectionHeader"><div><h2>Административный слой Harness</h2><p>Текущая версия v{latest?.version ?? "—"}, Git {latest?.git_revision ?? "без привязки"}. Каждая публикация неизменяема.</p></div><button className="button buttonPrimary" onClick={preparePublish}>Проверить и опубликовать</button></div><div className="harnessAdminGrid"><section className="harnessGroup"><h3>Назначение</h3><label>Название<input value={String(getValue("identity.name") ?? "")} onChange={(event) => setValue("identity.name", event.target.value)} /></label><label>Назначение<textarea value={String(getValue("identity.purpose") ?? "")} onChange={(event) => setValue("identity.purpose", event.target.value)} /></label></section><section className="harnessGroup wide"><h3>Главные инструкции</h3><label>Системный промпт<textarea className="promptEditor" value={String(getValue("instructions.system_prompt") ?? "")} onChange={(event) => setValue("instructions.system_prompt", event.target.value)} /></label><label>Правила выполнения<textarea value={String(getValue("instructions.developer_rules") ?? "")} onChange={(event) => setValue("instructions.developer_rules", event.target.value)} /></label><label>Порядок приоритетов<textarea value={(getValue("priority") ?? []).join("\n")} onChange={(event) => setValue("priority", event.target.value.split("\n").map((item) => item.trim()).filter(Boolean))} /></label></section>{flagGroups.map(([group, title, fields]) => <section className="harnessGroup" key={group}><h3>{title}</h3><div className="flagGrid">{fields.map(([key, label]) => <label className="flagRow" key={key}><input type="checkbox" checked={getValue(`${group}.${key}`) === true} onChange={(event) => setValue(`${group}.${key}`, event.target.checked)} /><span>{label}</span></label>)}</div></section>)}<section className="harnessGroup"><h3>Ответы и ресурсы</h3><div className="runtimeGrid"><label>Язык<input value={String(getValue("response.language") ?? "ru")} onChange={(event) => setValue("response.language", event.target.value)} /></label><label>Подробность<select value={String(getValue("response.detail") ?? "concise")} onChange={(event) => setValue("response.detail", event.target.value)}><option value="concise">Кратко</option><option value="balanced">Сбалансированно</option><option value="detailed">Подробно</option></select></label><label>Уровень рассуждения<select value={String(getValue("runtime.reasoning_effort") ?? "high")} onChange={(event) => setValue("runtime.reasoning_effort", event.target.value)}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">XHigh</option></select></label><label>Повторы<input type="number" min={0} max={10} value={Number(getValue("runtime.max_retries") ?? 3)} onChange={(event) => setValue("runtime.max_retries", Number(event.target.value))} /></label></div><label>Политика контекста<textarea value={String(getValue("runtime.context_policy") ?? "")} onChange={(event) => setValue("runtime.context_policy", event.target.value)} /></label></section></div>{report && <div className={`evalReport ${report.passed ? "passed" : "failed"}`}><strong>{report.passed ? "Все проверки пройдены" : "Публикация заблокирована"}</strong>{report.checks.filter((check) => !check.passed).map((check) => <p key={check.id}>{check.message}</p>)}</div>}<div className="notice"><ShieldCheck size={16} />База повторно проверит конфигурацию и Git-ревизию. Подменить результат проверки в браузере недостаточно.</div></section>;
}

function JobsAdmin({ data, confirm }: { data: AdminData; confirm: (text: string, action: () => Promise<void>) => void }) {
  return <div className="dataList">{data.jobs.length ? data.jobs.map((job) => <article className="adminRow" key={job.id}><div><strong>{job.operation}</strong><p>{job.project_service_id}</p><span className={"status status-" + (job.status === "completed" ? "ready" : job.status === "failed" ? "error" : "disabled")}>{job.status}</span>{job.last_error && <small className="fieldError">{job.last_error}</small>}</div>{job.status === "failed" && <button className="button buttonOutline" onClick={() => confirm("Повторно поставить операцию " + job.operation + " в очередь.", () => adminRetryJob(job.id))}>Повторить</button>}</article>) : <div className="emptyState">Очередь provisioning пуста.</div>}</div>;
}

function AuditAdmin({ data, confirm }: { data: AdminData; confirm: (text: string, action: () => Promise<void>) => void }) {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const localValue = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const [start, setStart] = React.useState(localValue(weekAgo));
  const [end, setEnd] = React.useState(localValue(now));
  return <div className="auditSection"><div className="auditToolbar"><label>С<input type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} /></label><label>По<input type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} /></label><button className="button buttonDanger" disabled={!start || !end || start >= end} onClick={() => confirm(`Безвозвратно удалить события аудита с ${new Date(start).toLocaleString("ru")} по ${new Date(end).toLocaleString("ru")}. Контрольный хеш останется в истории удаления.`, () => adminDeleteAuditPeriod(new Date(start).toISOString(), new Date(end).toISOString()))}>Удалить период</button></div><div className="tableWrap"><table className="dataTable"><thead><tr><th>Время</th><th>Действие</th><th>Проект</th><th>Объект</th></tr></thead><tbody>{data.audit.map((event) => <tr key={event.id}><td>{new Date(event.created_at).toLocaleString("ru")}</td><td><code>{event.action}</code></td><td>{event.project_id ?? "—"}</td><td>{event.target_type ? event.target_type + ": " + event.target_id : "—"}</td></tr>)}</tbody></table></div>{data.auditMeta.length > 0 && <div className="auditMeta"><h2>История удаления</h2>{data.auditMeta.map((event) => <p key={event.id}>{new Date(event.created_at).toLocaleString("ru")}: удалено {event.deleted_count}, контрольный хеш <code>{event.digest.slice(0, 12)}…</code></p>)}</div>}</div>;
}

function ProjectDashboard({ session, workspace, refresh }: { session: Session; workspace: Workspace; refresh: () => Promise<void> }) {
  const [tab, setTab] = React.useState<"active" | "archived">("active");
  const [dialog, setDialog] = React.useState<{ mode: "create" | "edit"; project?: Project } | null>(null);
  const [confirmProject, setConfirmProject] = React.useState<Project | null>(null);
  const [message, setMessage] = React.useState("");
  const [working, setWorking] = React.useState(false);
  const activeProject = workspace.projects.find((project) => project.id === workspace.profile.active_project_id)
    ?? workspace.projects.find((project) => project.status === "active")
    ?? null;
  const visibleProjects = workspace.projects.filter((project) => project.status === tab);
  const canManageAccount = workspace.accountRole === "owner";

  React.useEffect(() => {
    const requestedProjectId = new URLSearchParams(window.location.search).get("project");
    const requestedProject = workspace.projects.find((project) => project.id === requestedProjectId && project.status === "active");
    if (!requestedProject || requestedProject.id === activeProject?.id) return;
    window.history.replaceState(null, "", "/account");
    setActiveProjectForTab(workspace.account.id, requestedProject.id);
    void refresh();
  }, [activeProject?.id, refresh, workspace.account.id, workspace.projects]);

  async function chooseProject(project: Project) {
    setActiveProjectForTab(workspace.account.id, project.id);
    await refresh();
  }

  async function confirmArchive() {
    if (!confirmProject) return;
    setWorking(true);
    setMessage("");
    try {
      await archiveProject(confirmProject.id);
      setConfirmProject(null);
      await refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Не удалось архивировать проект");
    } finally {
      setWorking(false);
    }
  }

  async function restore(project: Project) {
    setWorking(true);
    try {
      await restoreProject(project.id);
      await refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Не удалось восстановить проект");
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className="dashboardShell">
      <div className="pageHeader">
        <div><span className="sectionKicker"><Fingerprint size={14} />account hub</span><h1>Проекты</h1><p>Каждый проект изолирует данные, сервисы, Harness и доступы агентов.</p></div>
        {canManageAccount && <button className="button buttonPrimary" type="button" onClick={() => setDialog({ mode: "create" })}><Plus size={16} />Создать проект</button>}
      </div>

      <IncomingInvitations session={session} workspace={workspace} refresh={refresh} />

      <div className="tabs" role="tablist" aria-label="Состояние проектов">
        <button className={tab === "active" ? "active" : ""} onClick={() => setTab("active")}>Активные</button>
        <button className={tab === "archived" ? "active" : ""} onClick={() => setTab("archived")}>Архив</button>
      </div>

      {message && <div className="notice errorNotice">{message}</div>}
      <div className="projectGrid">
        {visibleProjects.map((project) => (
          <article className={`projectCard${project.id === activeProject?.id ? " selected" : ""}`} key={project.id}>
            <button className="projectCardMain" type="button" onClick={() => void chooseProject(project)} disabled={project.status !== "active"}>
              <ProjectLogo project={project} />
              <span><strong>{project.name}</strong><small>{project.description || "Без описания"}</small></span>
            </button>
            <div className="projectMeta"><code>{project.slug}</code>{project.is_system && <span className="badge">Системный</span>}{project.id === activeProject?.id && <span className="badge dark">Активный</span>}</div>
            <div className="projectActions">
              {project.status === "active" && canManageAccount ? (
                <>
                  <button className="iconButton" title="Изменить" disabled={project.is_system} onClick={() => setDialog({ mode: "edit", project })}><Pencil size={16} /></button>
                  <button className="iconButton" title="Архивировать" disabled={project.is_system} onClick={() => setConfirmProject(project)}><Archive size={16} /></button>
                </>
              ) : project.status === "archived" && canManageAccount ? (
                <button className="button buttonOutline" disabled={working} onClick={() => void restore(project)}><RotateCcw size={15} />Восстановить</button>
              ) : null}
            </div>
          </article>
        ))}
        {!visibleProjects.length && <div className="emptyState">В этом разделе пока нет проектов.</div>}
      </div>

      {canManageAccount && <BillingPanel session={session} workspace={workspace} refresh={refresh} />}
      {activeProject?.status === "active" && <ProjectWorkspace session={session} project={activeProject} workspace={workspace} refresh={refresh} />}
      {dialog && <ProjectDialog accountId={workspace.account.id} state={dialog} services={workspace.services} onClose={() => setDialog(null)} onSaved={async () => { setDialog(null); await refresh(); }} />}
      {confirmProject && (
        <ConfirmDialog
          title="Ты уверен, босс?"
          text={`Проект «${confirmProject.name}» будет отключён от активных сервисов и перемещён в архив. Его можно восстановить до окончательного удаления.`}
          confirm="Архивировать"
          working={working}
          onClose={() => setConfirmProject(null)}
          onConfirm={() => void confirmArchive()}
        />
      )}
    </section>
  );
}

function BillingPanel({ session, workspace, refresh }: { session: Session; workspace: Workspace; refresh: () => Promise<void> }) {
  const [seats, setSeats] = React.useState(Math.max(1, workspace.subscription?.seats ?? 2));
  const [working, setWorking] = React.useState("");
  const [message, setMessage] = React.useState("");
  const currentPlan = workspace.plans.find((plan) => plan.id === workspace.subscription?.plan_id);
  const billingSuccess = new URLSearchParams(window.location.search).get("billing") === "success";

  React.useEffect(() => {
    if (!billingSuccess) return;
    window.history.replaceState(null, "", "/account");
    const timer = window.setTimeout(() => void refresh(), 2000);
    return () => window.clearTimeout(timer);
  }, [billingSuccess, refresh]);

  async function openCheckout(planCode: string, unitCount: number) {
    const checkoutTab = window.open("about:blank", "_blank");
    if (checkoutTab) checkoutTab.opener = null;
    setWorking(planCode);
    setMessage("");
    try {
      const url = await createBillingCheckout(session, workspace.account.id, planCode, unitCount);
      if (checkoutTab) checkoutTab.location.replace(url);
      else window.location.assign(url);
    } catch (cause) {
      checkoutTab?.close();
      setMessage(cause instanceof Error ? cause.message : "Не удалось открыть оплату");
    } finally {
      setWorking("");
    }
  }

  const plans = workspace.plans
    .filter((plan) => ["golden", "corporate"].includes(plan.code))
    .sort((left, right) => ["golden", "corporate"].indexOf(left.code) - ["golden", "corporate"].indexOf(right.code));
  return <section className="billingPanel"><div className="sectionHeader"><div><span className="sectionKicker"><CreditCard size={14} />оплата</span><h2>Тариф аккаунта</h2><p>Оплата действует для всех проектов этого аккаунта.</p></div><div className="billingStatus"><strong>{currentPlan?.name ?? "Пробный период"}</strong><span className={`status status-${workspace.subscription?.status === "active" ? "ready" : "disabled"}`}>{billingStatusLabel(workspace.subscription?.status)}</span></div></div>{billingSuccess && <div className="notice">Оплата завершена. Обновляем статус подписки.</div>}{message && <div className="notice errorNotice">{message}</div>}<div className="billingPlans">{plans.map((plan) => <article className="billingPlan" key={plan.id}><div><strong>{plan.name}</strong><p>${(plan.price_cents / 100).toFixed(0)} в месяц {plan.billing_mode === "seat" ? "за участника" : "за аккаунт"} · 14 дней бесплатно</p></div>{plan.billing_mode === "seat" && <label>Участники<input type="number" min={1} max={1000} value={seats} onChange={(event) => setSeats(Math.max(1, Number(event.target.value) || 1))} /></label>}<button className="button buttonPrimary" disabled={Boolean(working)} onClick={() => void openCheckout(plan.code, plan.billing_mode === "seat" ? seats : 1)}>{working === plan.code ? "Открываем..." : "Выбрать"}</button></article>)}</div>{workspace.subscription?.current_period_end && <p className="billingPeriod">Текущий период до {new Date(workspace.subscription.current_period_end).toLocaleDateString("ru")}</p>}</section>;
}

function billingStatusLabel(status?: string) {
  const labels: Record<string, string> = { trialing: "Активен", active: "Активен", past_due: "Нужна оплата", paused: "Приостановлен", canceled: "Отменён", expired: "Завершён" };
  return labels[status ?? ""] ?? "Не подключён";
}

function IncomingInvitations({ session, workspace, refresh }: { session: Session; workspace: Workspace; refresh: () => Promise<void> }) {
  const [working, setWorking] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState("");
  if (!workspace.incomingInvitations.length) return null;

  async function accept(invitationId: string) {
    setWorking(invitationId);
    setMessage("");
    try {
      const result = await acceptProjectInvitation(invitationId);
      setActiveAccountForTab(session.user.id, result.account_id);
      setActiveProjectForTab(result.account_id, result.project_id);
      await refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Не удалось принять приглашение");
    } finally {
      setWorking(null);
    }
  }

  return <section className="invitationInbox"><div><span className="sectionKicker"><Mail size={14} />приглашения</span><h2>Вас пригласили в проект</h2></div>{workspace.incomingInvitations.map((invitation) => <div className="incomingInvitation" key={invitation.invitation_id}><div><strong>{invitation.project_name}</strong><small>{invitation.account_name}{invitation.invited_by_name ? ` · ${invitation.invited_by_name}` : ""}</small></div><button className="button buttonPrimary" disabled={working === invitation.invitation_id} onClick={() => void accept(invitation.invitation_id)}>{working === invitation.invitation_id ? "Добавляем..." : "Принять"}</button></div>)}{message && <div className="notice errorNotice">{message}</div>}</section>;
}

function ProjectLogo({ project }: { project: Project }) {
  return <span className="projectLogo">{project.logo_url ? <img src={project.logo_url} alt="" /> : project.name.slice(0, 1).toUpperCase()}</span>;
}

function ProjectWorkspace({ session, project, workspace, refresh }: { session: Session; project: Project; workspace: Workspace; refresh: () => Promise<void> }) {
  const connections = workspace.projectServices.filter((item) => item.project_id === project.id);
  const canManage = workspace.projectAccess?.role === "owner";
  const [message, setMessage] = React.useState("");

  async function toggle(service: Service, enabled: boolean) {
    setMessage("");
    try {
      await setServiceEnabled(project.id, service.slug, enabled);
      await refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Не удалось изменить сервис");
    }
  }

  return (
    <div className="workspaceSection">
      <div className="sectionHeader"><div><span className="sectionKicker">активный проект</span><h2>{project.name}</h2></div><span className="badge dark">{connections.filter((item) => item.status === "ready" && !workspace.services.find((service) => service.id === item.service_id)?.is_core).length} сервисов готово</span></div>
      {message && <div className="notice errorNotice">{message}</div>}
      <div className="serviceList">
        {workspace.services.filter((service) => !service.is_core).map((service) => {
          const connection = connections.find((item) => item.service_id === service.id);
          const enabled = connection && connection.status !== "disabled" && connection.status !== "archived";
          return (
            <article className="serviceRow" key={service.id}>
              <div><div className="serviceName"><strong>{service.name}</strong><span className={`status status-${connection?.status ?? "disabled"}`}>{statusLabel(connection?.status)}</span></div><p>{service.description}</p>{connection?.last_error && <small className="fieldError">{connection.last_error}</small>}</div>
              <div className="serviceActions">
                <label className="switch" title={canManage ? "Включить или выключить сервис" : "Сервисами управляет владелец проекта"}><input type="checkbox" checked={Boolean(enabled)} disabled={!canManage} onChange={(event) => void toggle(service, event.target.checked)} /><span /></label>
                {connection?.status === "ready" ? <a className="button buttonOutline" href={serviceLaunchHref(project.id, service.slug)} target="_blank" rel="noopener noreferrer">Открыть<ExternalLink size={15} /></a> : <button className="button buttonOutline" type="button" disabled>Открыть<ExternalLink size={15} /></button>}
                {canManage && service.mcp_url && connection?.status === "ready" && <a className="button buttonGhost" href="#mcp-access">MCP<KeyRound size={14} /></a>}
              </div>
            </article>
          );
        })}
      </div>
      {projectDataEnabled && <ProjectDataPanel session={session} project={project} canManage={canManage} />}
      <MembersPanel project={project} workspace={workspace} refresh={refresh} />
      <McpPanel project={project} workspace={workspace} refresh={refresh} canManage={canManage} />
      <HarnessPanel project={project} workspace={workspace} refresh={refresh} canManage={canManage} />
    </div>
  );
}

type DataView = "knowledge" | "files" | "secrets";

function bytesLabel(value: number, limit: number | null) {
  const used = value < 1024 * 1024 ? `${Math.max(1, Math.round(value / 1024))} КБ` : `${(value / 1024 / 1024).toFixed(1)} МБ`;
  return limit === null ? used : `${used} из ${Math.round(limit / 1024 / 1024)} МБ`;
}

function ProjectDataPanel({ session, project, canManage }: { session: Session; project: Project; canManage: boolean }) {
  const [view, setView] = React.useState<DataView>("knowledge");
  const [knowledge, setKnowledge] = React.useState<KnowledgeDocument[]>([]);
  const [files, setFiles] = React.useState<ProjectFile[]>([]);
  const [secrets, setSecrets] = React.useState<ProjectSecret[]>([]);
  const [summary, setSummary] = React.useState<ProjectStorageSummary | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [working, setWorking] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [content, setContent] = React.useState("");
  const [secretId, setSecretId] = React.useState<string | undefined>();
  const [secretName, setSecretName] = React.useState("");
  const [secretValue, setSecretValue] = React.useState("");
  const [secretKind, setSecretKind] = React.useState<ProjectSecret["kind"]>("api_key");
  const [secretService, setSecretService] = React.useState("");
  const [secretDescription, setSecretDescription] = React.useState("");
  const [confirmation, setConfirmation] = React.useState<{ text: string; action: () => Promise<void> } | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const stored = await loadProjectStorage(project.id);
      setKnowledge(stored.knowledge);
      setFiles(stored.files);
      setSummary(stored.summary);
      setSecrets(canManage ? await listProjectSecrets(session, project.id) : []);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Не удалось загрузить хранилище");
    } finally {
      setLoading(false);
    }
  }, [canManage, project.id, session]);

  React.useEffect(() => { void load(); }, [load]);

  async function run(action: () => Promise<unknown>) {
    setWorking(true);
    setMessage("");
    try {
      await action();
      await load();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Операция не выполнена");
    } finally {
      setWorking(false);
    }
  }

  async function saveKnowledge(event: React.FormEvent) {
    event.preventDefault();
    await run(async () => {
      await saveProjectKnowledge(project.id, title, content);
      setTitle("");
      setContent("");
      setMessage("Документ добавлен в память проекта.");
    });
  }

  async function search(event: React.FormEvent) {
    event.preventDefault();
    setWorking(true);
    setMessage("");
    try {
      if (!query.trim()) return await load();
      setKnowledge(await searchProjectKnowledge(project.id, query));
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Поиск не выполнен");
    } finally {
      setWorking(false);
    }
  }

  async function upload(file?: File) {
    if (!file) return;
    await run(async () => { await uploadProjectFile(project.id, file); });
  }

  function editSecret(secret: ProjectSecret) {
    setSecretId(secret.id);
    setSecretName(secret.name);
    setSecretKind(secret.kind);
    setSecretService(secret.service_slug || "");
    setSecretDescription(secret.description || "");
    setSecretValue("");
  }

  function resetSecretForm() {
    setSecretId(undefined);
    setSecretName("");
    setSecretValue("");
    setSecretKind("api_key");
    setSecretService("");
    setSecretDescription("");
  }

  async function saveSecret(event: React.FormEvent) {
    event.preventDefault();
    await run(async () => {
      await saveProjectSecret(session, {
        projectId: project.id,
        secretId,
        name: secretName,
        kind: secretKind,
        serviceSlug: secretService,
        description: secretDescription,
        value: secretValue,
      });
      resetSecretForm();
      setMessage(secretId ? "Секрет заменён новой версией." : "Секрет сохранён.");
    });
  }

  async function confirmAction() {
    if (!confirmation) return;
    const action = confirmation.action;
    setConfirmation(null);
    await run(action);
  }

  return (
    <section className="dataPanel" id="project-data">
      <div className="sectionHeader">
        <div><span className="sectionKicker"><Database size={14} />project data</span><h2>Данные проекта</h2><p>Память, приватные файлы и секреты доступны только участникам активного проекта.</p></div>
        {summary && <div className="storageStats"><span>Память <strong>{bytesLabel(summary.vector_bytes, summary.vector_limit_bytes)}</strong></span><span>Файлы <strong>{bytesLabel(summary.file_bytes, summary.file_limit_bytes)}</strong></span>{canManage && <span>Секреты <strong>{summary.secret_count}{summary.secret_limit === null ? "" : ` из ${summary.secret_limit}`}</strong></span>}</div>}
      </div>
      <div className="dataTabs" role="tablist">
        <button className={view === "knowledge" ? "active" : ""} onClick={() => setView("knowledge")}><BrainCircuit size={15} />Память</button>
        <button className={view === "files" ? "active" : ""} onClick={() => setView("files")}><Files size={15} />Файлы</button>
        {canManage && <button className={view === "secrets" ? "active" : ""} onClick={() => setView("secrets")}><LockKeyhole size={15} />Секреты</button>}
      </div>
      {message && <div className={message.startsWith("Не удалось") || message.includes("недоступ") ? "notice errorNotice" : "notice"}>{message}</div>}
      {loading ? <div className="dataLoading"><LoaderCircle className="spin" size={18} />Загружаем данные</div> : view === "knowledge" ? (
        <div className="dataView">
          <form className="knowledgeSearch" onSubmit={search}><label><Search size={15} /><input value={query} placeholder="Поиск по памяти проекта" onChange={(event) => setQuery(event.target.value)} /></label><button className="button buttonOutline" disabled={working}>Найти</button></form>
          <form className="knowledgeCreate" onSubmit={saveKnowledge}><label>Название<input value={title} maxLength={240} required onChange={(event) => setTitle(event.target.value)} /></label><label>Содержание<textarea value={content} maxLength={200000} required rows={4} onChange={(event) => setContent(event.target.value)} /></label><button className="button buttonPrimary" disabled={working || !title.trim() || !content.trim()}>Добавить в память</button></form>
          <div className="dataRows">{knowledge.map((document) => <article className="dataRow" key={document.id}><FileText size={18} /><div><strong>{document.title}</strong><p>{document.content}</p><small>{document.service_slug} · {document.embedding_model ? `vector: ${document.embedding_model}` : "полнотекстовый индекс"}{document.score !== undefined ? ` · релевантность ${Math.round(document.score * 100)}%` : ""}</small></div><button className="iconButton" title="Удалить документ" onClick={() => setConfirmation({ text: `Удалить «${document.title}» из памяти проекта?`, action: () => deleteProjectKnowledge(project.id, document.id) })}><Trash2 size={15} /></button></article>)}{!knowledge.length && <div className="emptyState">В памяти проекта пока нет документов.</div>}</div>
        </div>
      ) : view === "files" ? (
        <div className="dataView">
          <label className="fileUpload button buttonPrimary"><Upload size={15} />Загрузить файл<input type="file" disabled={working} accept=".txt,.md,.csv,.json,.pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx" onChange={(event) => { void upload(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>
          <div className="dataRows">{files.map((file) => <article className="dataRow" key={file.id}><Files size={18} /><div><strong>{file.file_name}</strong><small>{file.mime_type} · {bytesLabel(file.size_bytes, null)}</small></div><button className="button buttonOutline" onClick={() => void openProjectFile(file)}>Открыть<ExternalLink size={14} /></button><button className="iconButton" title="Удалить файл" onClick={() => setConfirmation({ text: `Удалить файл «${file.file_name}»?`, action: () => deleteProjectFile(file) })}><Trash2 size={15} /></button></article>)}{!files.length && <div className="emptyState">В проект ещё не загружены файлы.</div>}</div>
        </div>
      ) : (
        <div className="dataView">
          <div className="secretRule"><ShieldCheck size={18} /><p>Значения шифруются на сервере и никогда не показываются повторно. Агенты видят только наличие секрета, а сервисы используют его внутри защищённого контура.</p></div>
          <form className="secretCreate" onSubmit={saveSecret}><label>Имя<input value={secretName} placeholder="SERVICE_API_KEY" required onChange={(event) => setSecretName(event.target.value.toUpperCase())} /></label><label>Тип<select value={secretKind} onChange={(event) => setSecretKind(event.target.value as ProjectSecret["kind"])}><option value="api_key">API key</option><option value="token">Token</option><option value="password">Password</option><option value="credential">Credential</option><option value="custom">Custom</option></select></label><label>Сервис<input value={secretService} placeholder="openseo" onChange={(event) => setSecretService(event.target.value.toLowerCase())} /></label><label>Описание<input value={secretDescription} maxLength={500} onChange={(event) => setSecretDescription(event.target.value)} /></label><label className="secretValue">{secretId ? "Новое значение" : "Значение"}<input type="password" autoComplete="new-password" value={secretValue} required onChange={(event) => setSecretValue(event.target.value)} /></label><div className="secretFormActions"><button className="button buttonPrimary" disabled={working || !secretName || !secretValue}>{secretId ? "Заменить секрет" : "Сохранить секрет"}</button>{secretId && <button className="button buttonGhost" type="button" onClick={resetSecretForm}>Отмена</button>}</div></form>
          <div className="dataRows">{secrets.map((secret) => <article className="dataRow" key={secret.id}><KeyRound size={18} /><div><div className="serviceName"><strong>{secret.name}</strong><span className={`status status-${secret.status === "active" ? "ready" : "disabled"}`}>{secret.status === "active" ? "Активен" : "Отключён"}</span></div><small>{secret.kind} · версия {secret.version}{secret.service_slug ? ` · ${secret.service_slug}` : ""}</small>{secret.description && <p>{secret.description}</p>}</div><button className="button buttonOutline" onClick={() => editSecret(secret)}>Заменить</button><button className="button buttonGhost" onClick={() => void run(() => setProjectSecretStatus(session, secret.id, secret.status === "active" ? "disabled" : "active"))}>{secret.status === "active" ? "Отключить" : "Включить"}</button><button className="iconButton" title="Удалить секрет" onClick={() => setConfirmation({ text: `Удалить секрет ${secret.name}? Восстановить его значение будет нельзя.`, action: () => deleteProjectSecret(session, secret.id) })}><Trash2 size={15} /></button></article>)}{!secrets.length && <div className="emptyState">У проекта пока нет секретов.</div>}</div>
        </div>
      )}
      {confirmation && <ConfirmDialog title="Ты уверен, босс?" text={confirmation.text} confirm="Подтвердить" working={working} onClose={() => setConfirmation(null)} onConfirm={() => void confirmAction()} />}
    </section>
  );
}

function MembersPanel({ project, workspace, refresh }: { project: Project; workspace: Workspace; refresh: () => Promise<void> }) {
  const access = workspace.projectAccess;
  const canManage = access?.role === "owner";
  const [email, setEmail] = React.useState("");
  const [working, setWorking] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [confirmation, setConfirmation] = React.useState<{ kind: "member" | "invitation"; id: string; label: string } | null>(null);

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    setWorking(true);
    setMessage("");
    try {
      await createProjectInvitation(project.id, email);
      setEmail("");
      await refresh();
      setMessage("Приглашение поставлено в очередь на отправку.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Не удалось отправить приглашение");
    } finally {
      setWorking(false);
    }
  }

  async function confirmRemoval() {
    if (!confirmation) return;
    setWorking(true);
    setMessage("");
    try {
      if (confirmation.kind === "member") await removeProjectMember(project.id, confirmation.id);
      else await revokeProjectInvitation(confirmation.id);
      setConfirmation(null);
      await refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Не удалось изменить доступ");
    } finally {
      setWorking(false);
    }
  }

  if (!access) return null;
  return (
    <section className="membersPanel">
      <div className="sectionHeader"><div><span className="sectionKicker"><Users size={14} />project access</span><h2>Участники проекта</h2><p>Одна учётная запись Spaces открывает участнику этот проект во всех подключённых сервисах.</p></div><span className="badge">{access.members.length} участников</span></div>
      {canManage && <form className="inviteForm" onSubmit={invite}><label>Email участника<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" required /></label><button className="button buttonPrimary" disabled={working || !email.trim()}>{working ? "Отправляем..." : "Пригласить"}</button></form>}
      {message && <div className={message.startsWith("Не удалось") ? "notice errorNotice" : "notice"}>{message}</div>}
      <div className="memberList">
        {access.members.map((member) => {
          const name = member.display_name || member.email || "Участник";
          return <div className="memberRow" key={member.user_id}><Avatar name={name} url={member.avatar_url} /><div><strong>{name}</strong><small>{member.email}</small></div><span className="badge">{member.role === "owner" ? "Владелец" : "Участник"}</span>{canManage && member.role !== "owner" && <button className="iconButton" type="button" title="Удалить из проекта" onClick={() => setConfirmation({ kind: "member", id: member.user_id, label: name })}><Trash2 size={15} /></button>}</div>;
        })}
        {canManage && access.invitations.map((invitation) => <div className="memberRow pendingMember" key={invitation.id}><span className="pendingAvatar"><Mail size={15} /></span><div><strong>{invitation.email}</strong><small>{invitation.delivery_status === "sent" ? "Письмо отправлено" : invitation.delivery_status === "failed" ? "Ошибка отправки, повторим автоматически" : "Готовим письмо"} · до {new Date(invitation.expires_at).toLocaleDateString("ru")}</small></div><span className="badge">Ожидает</span><button className="iconButton" type="button" title="Отозвать приглашение" onClick={() => setConfirmation({ kind: "invitation", id: invitation.id, label: invitation.email })}><X size={15} /></button></div>)}
      </div>
      {confirmation && <ConfirmDialog title="Изменить доступ?" text={confirmation.kind === "member" ? `Удалить ${confirmation.label} из проекта «${project.name}»? Данные проекта сохранятся.` : `Отозвать приглашение для ${confirmation.label}?`} confirm={confirmation.kind === "member" ? "Удалить участника" : "Отозвать"} working={working} onClose={() => setConfirmation(null)} onConfirm={() => void confirmRemoval()} />}
    </section>
  );
}

function McpPanel({ project, workspace, refresh, canManage }: { project: Project; workspace: Workspace; refresh: () => Promise<void>; canManage: boolean }) {
  const credentials = workspace.mcpCredentials.filter((credential) => credential.project_id === project.id);
  const [name, setName] = React.useState("");
  const [lifetime, setLifetime] = React.useState("90");
  const [scopes, setScopes] = React.useState(["memory:read", "memory:write", "knowledge:read", "knowledge:write", "openseo:*"]);
  const [revealed, setRevealed] = React.useState<{ token: string; name: string } | null>(null);
  const [revokeTarget, setRevokeTarget] = React.useState<string | null>(null);
  const [working, setWorking] = React.useState(false);
  const [message, setMessage] = React.useState("");

  async function create() {
    setWorking(true);
    setMessage("");
    try {
      const days = Number(lifetime);
      const expiresAt = lifetime === "permanent" ? null : new Date(Date.now() + days * 86_400_000).toISOString();
      const credential = await createMcpCredential(project.id, name, expiresAt, scopes);
      setRevealed({ token: credential.token, name: credential.name });
      setName("");
      await refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Не удалось создать MCP-ключ");
    } finally {
      setWorking(false);
    }
  }

  async function revoke() {
    if (!revokeTarget) return;
    setWorking(true);
    setMessage("");
    try {
      await revokeMcpCredential(revokeTarget);
      setRevokeTarget(null);
      await refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Не удалось отозвать MCP-ключ");
    } finally {
      setWorking(false);
    }
  }

  async function copy(value: string) {
    await navigator.clipboard.writeText(value);
    setMessage("Скопировано.");
  }

  function toggleScope(scope: string) {
    setScopes((current) => {
      if (current.includes(scope)) {
        if (scope === "memory:read") return current.filter((item) => item !== "memory:read" && item !== "memory:write");
        if (scope === "knowledge:read") return current.filter((item) => item !== "knowledge:read" && item !== "knowledge:write");
        return current.filter((item) => item !== scope);
      }
      if (scope === "memory:write") return Array.from(new Set([...current, "memory:read", "memory:write"]));
      if (scope === "knowledge:write") return Array.from(new Set([...current, "knowledge:read", "knowledge:write"]));
      return [...current, scope];
    });
  }

  if (!canManage) return <section className="mcpPanel" id="mcp-access"><div className="sectionHeader"><div><span className="sectionKicker"><KeyRound size={14} />agent access</span><h2>MCP-доступ проекта</h2><p>Ключами внешних агентов управляет владелец проекта.</p></div></div></section>;

  return (
    <section className="mcpPanel" id="mcp-access">
      <div className="sectionHeader">
        <div><span className="sectionKicker"><KeyRound size={14} />agent access</span><h2>MCP-доступ проекта</h2><p>Один отзывной ключ подключает агента к разрешённым сервисам и памяти только этого проекта.</p></div>
      </div>
      <div className="mcpEndpoint"><span>Endpoint</span><code>https://mcp.spaces.community/mcp</code><button className="iconButton" type="button" title="Копировать endpoint" onClick={() => void copy("https://mcp.spaces.community/mcp")}><Copy size={15} /></button></div>
      <div className="mcpCreate">
        <label>Название ключа<input value={name} maxLength={80} placeholder="Например, Codex на MacBook" onChange={(event) => setName(event.target.value)} /></label>
        <label>Срок действия<select value={lifetime} onChange={(event) => setLifetime(event.target.value)}><option value="30">30 дней</option><option value="90">90 дней</option><option value="365">1 год</option><option value="permanent">Без срока</option></select></label>
        <fieldset className="scopePicker"><legend>Доступ</legend><label><input type="checkbox" checked={scopes.includes("memory:read")} onChange={() => toggleScope("memory:read")} />Outline: чтение</label><label><input type="checkbox" checked={scopes.includes("memory:write")} onChange={() => toggleScope("memory:write")} />Outline: запись</label><label><input type="checkbox" checked={scopes.includes("knowledge:read")} onChange={() => toggleScope("knowledge:read")} />Память проекта: чтение</label><label><input type="checkbox" checked={scopes.includes("knowledge:write")} onChange={() => toggleScope("knowledge:write")} />Память проекта: запись</label><label><input type="checkbox" checked={scopes.includes("openseo:*")} onChange={() => toggleScope("openseo:*")} />OpenSEO</label></fieldset>
        <button className="button buttonPrimary" type="button" disabled={working || !name.trim() || !scopes.length} onClick={() => void create()}>Создать ключ</button>
      </div>
      {revealed && <div className="secretReveal"><div><strong>{revealed.name}</strong><p>Сохраните ключ сейчас. После закрытия он больше не будет показан.</p></div><code>{revealed.token}</code><button className="button buttonOutline" type="button" onClick={() => void copy(revealed.token)}><Copy size={15} />Копировать</button><button className="iconButton" type="button" title="Скрыть ключ" onClick={() => setRevealed(null)}><X size={15} /></button></div>}
      {message && <div className="notice">{message}</div>}
      <div className="credentialList">
        {credentials.map((credential) => {
          const expired = Boolean(credential.expires_at && new Date(credential.expires_at).getTime() <= Date.now());
          const active = !credential.revoked_at && !expired;
          return <div className="credentialRow" key={credential.id}><div><strong>{credential.name}</strong><small>{active ? "Активен" : credential.revoked_at ? "Отозван" : "Истёк"} · {credential.expires_at ? `до ${new Date(credential.expires_at).toLocaleDateString("ru")}` : "без срока"}{credential.last_used_at ? ` · использован ${new Date(credential.last_used_at).toLocaleString("ru")}` : " · ещё не использован"}</small></div><code>{credential.scopes.join(" · ")}</code>{active && <button className="iconButton" type="button" title="Отозвать ключ" onClick={() => setRevokeTarget(credential.id)}><Trash2 size={15} /></button>}</div>;
        })}
        {!credentials.length && <div className="emptyState">У проекта пока нет MCP-ключей.</div>}
      </div>
      {revokeTarget && <ConfirmDialog title="Ты уверен, босс?" text="Ключ немедленно перестанет работать у подключённого агента." confirm="Отозвать ключ" working={working} onClose={() => setRevokeTarget(null)} onConfirm={() => void revoke()} />}
    </section>
  );
}

function statusLabel(status?: string) {
  return ({ ready: "Готов", provisioning: "Создаётся", error: "Ошибка", disabled: "Выключен", suspended: "Приостановлен", archived: "В архиве" } as Record<string, string>)[status ?? "disabled"];
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function HarnessAdminLayer({ config }: { config: Record<string, unknown> }) {
  const identity = objectValue(config.identity);
  const instructions = objectValue(config.instructions);
  const runtime = objectValue(config.runtime);
  const groups = ["security", "quality", "tooling", "response", "memory"];
  return <div className="harnessLayer"><div className="harnessSummaryGrid"><section><span className="sectionKicker">identity</span><h3>{String(identity.name ?? "Harness")}</h3><p>{String(identity.purpose ?? "—")}</p></section><section><span className="sectionKicker">runtime</span><h3>{String(runtime.reasoning_effort ?? "—")}</h3><p>Повторы: {String(runtime.max_retries ?? "—")}</p></section></div><section className="harnessPrompt"><h3>Системный промпт</h3><p>{String(instructions.system_prompt ?? "—")}</p><h3>Правила выполнения</h3><p>{String(instructions.developer_rules ?? "—")}</p></section><div className="harnessRuleGroups">{groups.map((group) => <section key={group}><h3>{group}</h3>{Object.entries(objectValue(config[group])).map(([key, value]) => <div className="ruleRow" key={key}><span>{key.replace(/_/g, " ")}</span><strong>{value === true ? "Обязательно" : String(value)}</strong></div>)}</section>)}</div></div>;
}

function HarnessEvaluation({ report }: { report: HarnessPreview["evaluation_report"] }) {
  return <section className={`evalReport ${report.passed ? "passed" : "failed"}`}><strong>{report.passed ? "Проверка пройдена" : "Активация заблокирована"}</strong><div className="evalChecks">{report.checks.map((check) => <div key={check.id}>{check.passed ? <Check size={15} /> : <X size={15} />}<span>{check.message}</span></div>)}</div></section>;
}

function HarnessEffectiveLayer({ preview }: { preview: HarnessPreview | null }) {
  if (!preview) return <div className="emptyState">Итоговая конфигурация ещё не опубликована.</div>;
  const preferences = objectValue(preview.effective_config.project_preferences);
  return <div className="harnessLayer"><HarnessEvaluation report={preview.evaluation_report} />{preview.conflict_report.length > 0 && <section className="conflictList"><h3>Игнорируемые противоречия</h3>{preview.conflict_report.map((conflict, index) => <div className="notice errorNotice" key={`${conflict.field}-${index}`}><strong>{conflict.field}</strong><span>{conflict.reason}</span></div>)}</section>}<section><h3>Применяемые настройки проекта</h3><div className="effectivePreferences">{Object.entries(preferences).filter(([, value]) => String(value).trim()).map(([key, value]) => <div key={key}><strong>{key.replace(/_/g, " ")}</strong><p>{String(value)}</p></div>)}{!Object.values(preferences).some((value) => String(value).trim()) && <div className="emptyState">Проект использует административный слой без дополнений.</div>}</div></section><details className="configDetails"><summary>Полная итоговая конфигурация</summary><pre>{JSON.stringify(preview.effective_config, null, 2)}</pre></details></div>;
}

function HarnessPanel({ project, workspace, refresh, canManage }: { project: Project; workspace: Workspace; refresh: () => Promise<void>; canManage: boolean }) {
  const initial = workspace.harness?.user_config ?? {};
  const [config, setConfig] = React.useState<Record<string, unknown>>(initial);
  const [view, setView] = React.useState<HarnessView>("user");
  const [preview, setPreview] = React.useState<HarnessPreview | null>(null);
  const [rollbackTarget, setRollbackTarget] = React.useState<ProjectHarnessVersion | null>(null);
  const [confirmPublish, setConfirmPublish] = React.useState(false);
  const [previewing, setPreviewing] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const activeHistory = workspace.harnessHistory.find((version) => version.is_active) ?? null;
  const activePreview: HarnessPreview | null = activeHistory && workspace.harnessVersion ? {
    admin_config: workspace.harnessVersion.admin_config,
    user_config: activeHistory.user_config,
    effective_config: activeHistory.effective_config,
    conflict_report: activeHistory.conflict_report,
    evaluation_report: activeHistory.evaluation_report,
  } : null;
  const fields = [
    ["system_context", "Системный контекст", "Цели, терминология и важные ограничения проекта"],
    ["objectives", "Цели проекта", "Какие результаты и метрики считаются важными"],
    ["domain_terms", "Термины и сущности", "Названия продуктов, ролей, процессов и принятая терминология"],
    ["acceptance_criteria", "Критерии результата", "Как проверить, что задача выполнена полностью"],
    ["accuracy_rules", "Требования к точности", "Источники, перепроверка и допустимая неопределённость"],
    ["trusted_sources", "Доверенные источники", "Документы, базы и сайты, которым можно доверять"],
    ["response_preferences", "Предпочтения ответа", "Язык, тон, формат и степень подробности"],
    ["forbidden_actions", "Запрещённые действия", "Что агент не должен делать даже без технического запрета"],
    ["tool_preferences", "Предпочтения инструментов", "Какие сервисы и инструменты использовать в первую очередь"],
    ["required_deliverables", "Обязательные результаты", "Файлы, отчёты, проверки и доказательства выполнения"],
    ["memory_notes", "Память проекта", "Что важно сохранять как долгосрочный контекст проекта"],
    ["example_outputs", "Эталонные примеры", "Примеры ответов и результатов, которые считаются качественными"],
  ] as const;

  React.useEffect(() => { setConfig(initial); setPreview(null); }, [workspace.harness?.project_id, workspace.harness?.user_config]);

  function changeField(key: string, value: string) {
    setConfig((current) => ({ ...current, [key]: value }));
    setPreview(null);
    setMessage("");
  }

  async function runPreview() {
    setPreviewing(true);
    setMessage("");
    try {
      const result = await previewHarnessUserConfig(project.id, config);
      setPreview(result);
      setView("effective");
      if (!result.evaluation_report.passed) setMessage("Проверка не пройдена. Публикация заблокирована.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Не удалось проверить настройки");
    } finally {
      setPreviewing(false);
    }
  }

  async function save() {
    setSaving(true);
    setMessage("");
    try {
      await saveHarnessUserConfig(project.id, preview?.user_config ?? config);
      await refresh();
      setPreview(null);
      setConfirmPublish(false);
      setView("history");
      setMessage("Новая версия опубликована.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Не удалось сохранить настройки");
    } finally {
      setSaving(false);
    }
  }

  async function acceptUpdate() {
    try {
      await acceptHarnessVersion(project.id);
      await refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Не удалось применить версию");
    }
  }

  async function rollback() {
    if (!rollbackTarget) return;
    setSaving(true);
    setMessage("");
    try {
      await rollbackHarnessUserConfig(project.id, rollbackTarget.id);
      setRollbackTarget(null);
      await refresh();
      setView("history");
      setMessage(`Версия ${rollbackTarget.sequence} восстановлена как новая версия.`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Не удалось восстановить версию");
    } finally {
      setSaving(false);
    }
  }

  const actionLabels: Record<ProjectHarnessVersion["action"], string> = { initial: "Начальная", publish: "Публикация", admin_update: "Обновление правил", rollback: "Восстановление", migration: "Перенос" };

  return (
    <section className="harnessPanel">
      <div className="sectionHeader"><div><span className="sectionKicker"><Settings2 size={14} />harness</span><h2>Настройки среды</h2><p>Административный слой обязателен. Настройки проекта применяются только после проверки и подтверждения владельца.</p></div><div className="rowBadges"><span className="badge dark">admin v{workspace.harnessVersion?.version ?? "—"}</span><span className="badge">project v{activeHistory?.sequence ?? "—"}</span>{project.system_key === "spaces-root" && <span className="badge">Эталон</span>}</div></div>
      {canManage && workspace.harness?.offered_version_id && <div className="notice updateNotice"><span>Доступна новая версия административного шаблона. Она будет применена только после подтверждения.</span><button className="button buttonOutline" onClick={() => void acceptUpdate()}>Применить</button></div>}
      {harnessVersionsEnabled && <nav className="harnessTabs" aria-label="Слои Harness">{(["admin", "user", "effective", "history"] as HarnessView[]).map((item) => <button key={item} className={view === item ? "active" : ""} onClick={() => setView(item)}>{({ admin: "Административный", user: "Пользовательский", effective: "Итоговый", history: "История" } as Record<HarnessView, string>)[item]}</button>)}</nav>}
      {(!harnessVersionsEnabled || view === "user") && <><div className="harnessGrid">{fields.map(([key, label, placeholder]) => <label key={key}>{label}<textarea value={String(config[key] ?? "")} readOnly={!canManage} onChange={(event) => changeField(key, event.target.value)} placeholder={placeholder} /></label>)}</div><div className="notice"><ShieldCheck size={16} />Обязательные правила безопасности, изоляции проекта и проверки результата применяются без изменений.</div>{canManage && <div className="harnessActions">{harnessVersionsEnabled ? <button className="button buttonPrimary" disabled={previewing} onClick={() => void runPreview()}>{previewing ? "Проверяем..." : "Проверить изменения"}</button> : <button className="button buttonPrimary" disabled={saving} onClick={() => void save()}>{saving ? "Сохраняем..." : "Сохранить настройки"}</button>}</div>}</>}
      {harnessVersionsEnabled && view === "admin" && <HarnessAdminLayer config={workspace.harnessVersion?.admin_config ?? {}} />}
      {harnessVersionsEnabled && view === "effective" && <><HarnessEffectiveLayer preview={preview ?? activePreview} />{canManage && preview?.evaluation_report.passed && <div className="harnessActions"><button className="button buttonPrimary" onClick={() => setConfirmPublish(true)}>Опубликовать версию</button></div>}</>}
      {harnessVersionsEnabled && view === "history" && <div className="harnessHistory">{workspace.harnessHistory.map((version) => <article className={version.is_active ? "active" : ""} key={version.id}><div><div className="rowBadges"><strong>Версия {version.sequence}</strong>{version.is_active && <span className="badge dark">Активна</span>}<span className="badge">admin v{version.admin_version}</span></div><p>{actionLabels[version.action]} · {new Date(version.created_at).toLocaleString("ru")}</p><small>{version.author_name || version.author_email || version.created_by} · {version.evaluation_report.checks.filter((check) => check.passed).length}/{version.evaluation_report.checks.length} проверок</small></div>{canManage && !version.is_active && <button className="button buttonOutline" onClick={() => setRollbackTarget(version)}><RotateCcw size={15} />Восстановить</button>}</article>)}{!workspace.harnessHistory.length && <div className="emptyState">История версий пуста.</div>}</div>}
      {message && <div className="notice">{message}</div>}
      {!canManage && <div className="notice">Пользовательский слой этого проекта изменяет владелец.</div>}
      {confirmPublish && <ConfirmDialog title="Опубликовать Harness?" text="Проверенная конфигурация станет активной версией проекта. Предыдущая версия останется в истории." confirm="Опубликовать" working={saving} onClose={() => setConfirmPublish(false)} onConfirm={() => void save()} />}
      {rollbackTarget && <ConfirmDialog title="Восстановить версию?" text={`Настройки версии ${rollbackTarget.sequence} будут повторно проверены с текущим административным слоем и опубликованы как новая версия.`} confirm="Восстановить" working={saving} onClose={() => setRollbackTarget(null)} onConfirm={() => void rollback()} />}
    </section>
  );
}

function ProjectDialog({ accountId, state, services, onClose, onSaved }: { accountId: string; state: { mode: "create" | "edit"; project?: Project }; services: Service[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const project = state.project;
  const [name, setName] = React.useState(project?.name ?? "");
  const [description, setDescription] = React.useState(project?.description ?? "");
  const [logoUrl, setLogoUrl] = React.useState(project?.logo_url ?? "");
  const [selectedServices, setSelectedServices] = React.useState<string[]>(services.filter((service) => !service.is_core).map((service) => service.slug));
  const [error, setError] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      if (state.mode === "create") await createProject(accountId, { name, description, logoUrl, services: selectedServices });
      else if (project) await updateProject(project.id, { name, description, logoUrl });
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось сохранить проект");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialogBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title" onSubmit={submit}>
        <div className="dialogHeader"><div><h2 id="project-dialog-title">{state.mode === "create" ? "Новый проект" : "Настройки проекта"}</h2><p>Название проекта станет именем tenant/workspace в подключённых сервисах.</p></div><button className="iconButton" type="button" aria-label="Закрыть" onClick={onClose}><X size={17} /></button></div>
        <div className="formGrid">
          <label>Название<input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required autoFocus /></label>
          <label>Описание<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} /></label>
          <label>Ссылка на логотип<input type="url" value={logoUrl} onChange={(event) => setLogoUrl(event.target.value)} placeholder="https://" /></label>
          {state.mode === "create" && <fieldset><legend>Сервисы</legend>{services.filter((service) => !service.is_core).map((service) => <label className="checkRow" key={service.id}><input type="checkbox" checked={selectedServices.includes(service.slug)} onChange={(event) => setSelectedServices((current) => event.target.checked ? [...current, service.slug] : current.filter((slug) => slug !== service.slug))} /><span>{service.name}</span></label>)}</fieldset>}
        </div>
        {error && <div className="notice errorNotice">{error}</div>}
        <div className="dialogActions"><button className="button buttonGhost" type="button" onClick={onClose}>Отмена</button><button className="button buttonPrimary" disabled={saving}>{saving ? "Сохраняем..." : "Сохранить"}</button></div>
      </form>
    </div>
  );
}

function ConfirmDialog({ title, text, confirm, working, onClose, onConfirm }: { title: string; text: string; confirm: string; working: boolean; onClose: () => void; onConfirm: () => void }) {
  return <div className="dialogBackdrop"><div className="dialog confirmDialog" role="alertdialog" aria-modal="true"><h2>{title}</h2><p>{text}</p><div className="dialogActions"><button className="button buttonGhost" onClick={onClose}>Отмена</button><button className="button buttonDanger" disabled={working} onClick={onConfirm}>{working ? "Подождите..." : confirm}</button></div></div></div>;
}

function AuthPage({ mode }: { mode: AuthMode }) {
  const isLogin = mode === "login";
  const isRegister = mode === "register";
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [name, setName] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const title = isLogin ? "Вход в Spaces" : isRegister ? "Создать аккаунт Spaces" : "Восстановить пароль";
  const lead = isLogin ? "Один вход для всех сервисов экосистемы." : isRegister ? "Создайте единый аккаунт для проектов и сервисов." : "Отправим ссылку для сброса пароля.";
  const requestedRedirect = new URLSearchParams(window.location.search).get("redirect");
  const redirect = requestedRedirect?.startsWith("/") && !requestedRedirect.startsWith("//") ? requestedRedirect : "/account";

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return setMessage("Авторизация не подключена.");
    setLoading(true);
    setMessage("");
    const result = isLogin
      ? await supabase.auth.signInWithPassword({ email, password })
      : isRegister
        ? await supabase.auth.signUp({ email, password, options: { data: { name }, emailRedirectTo: `${window.location.origin}${redirect}` } })
        : await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/reset-password` });
    setLoading(false);
    if (result.error) return setMessage(result.error.message);
    if (isLogin) return window.location.assign(redirect);
    setMessage(isRegister ? "Аккаунт создан. Проверьте почту для подтверждения." : "Ссылка отправлена. Проверьте почту.");
  }

  async function googleAuth() {
    if (!supabase) return setMessage("Авторизация не подключена.");
    const { error } = await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: `${window.location.origin}${redirect}` } });
    if (error) setMessage(error.message);
  }

  return (
    <section className="authShell">
      <div className="authAside"><div className="eyebrow"><KeyRound size={15} />secure access</div><h1>{title}</h1><p>{lead}</p><div className="authPromise"><ShieldCheck size={19} /><span>Доступ пользователя ограничивается активным аккаунтом и проектом.</span></div></div>
      <form className="authForm" onSubmit={handleSubmit}>
        {isRegister && <label>Имя<input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required /></label>}
        <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label>
        {mode !== "forgot" && <label>Пароль<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={isLogin ? "current-password" : "new-password"} minLength={8} required /></label>}
        <button className="button buttonPrimary buttonFull" disabled={loading}>{loading ? "Подождите..." : isLogin ? "Войти" : isRegister ? "Зарегистрироваться" : "Отправить ссылку"}</button>
        {mode !== "forgot" && <button className="button buttonOutline buttonFull" type="button" onClick={() => void googleAuth()}><Mail size={17} />Продолжить с Google</button>}
        {message && <p className="formMessage">{message}</p>}
        <div className="authLinks">{!isLogin && <a href="/login">Уже есть аккаунт</a>}{!isRegister && <a href="/register">Создать аккаунт</a>}{mode !== "forgot" && <a href="/forgot">Напомнить пароль</a>}</div>
      </form>
    </section>
  );
}

function ResetPasswordPage() {
  const [password, setPassword] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return setMessage("Авторизация не подключена.");
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) return setMessage(error.message);
    setMessage("Пароль обновлён.");
    window.setTimeout(() => window.location.assign("/account"), 700);
  }
  return <section className="authShell"><div className="authAside"><div className="eyebrow"><LockKeyhole size={15} />password reset</div><h1>Новый пароль</h1><p>Установите новый пароль для аккаунта Spaces.</p></div><form className="authForm" onSubmit={submit}><label>Новый пароль<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} required autoFocus /></label><button className="button buttonPrimary buttonFull" disabled={loading}>{loading ? "Сохраняем..." : "Обновить пароль"}</button>{message && <p className="formMessage">{message}</p>}</form></section>;
}

function LegalPage({ type }: { type: "privacy" | "terms" }) {
  const privacy = type === "privacy";
  return <section className="legalPage"><div className="eyebrow"><ShieldCheck size={15} />Spaces legal</div><h1>{privacy ? "Privacy Policy" : "Terms of Service"}</h1><p className="legalLead">{privacy ? "Spaces обрабатывает данные аккаунта, проектов и подключённых сервисов только для работы платформы." : "Правила использования платформы Spaces."}</p><div className="legalContent">{privacy ? <><h2>Данные</h2><p>Мы храним профиль, членство, проектные настройки и журнал действий.</p><h2>Изоляция</h2><p>Доступ к данным ограничивается аккаунтом, проектом и ролью пользователя.</p><h2>Контакт</h2><p>digitalcluster25@gmail.com</p></> : <><h2>Доступ</h2><p>Пользователь отвечает за действия в своих проектах и сохранность доступа.</p><h2>Допустимое использование</h2><p>Запрещено обходить авторизацию и получать чужие данные.</p><h2>Контакт</h2><p>digitalcluster25@gmail.com</p></>}</div></section>;
}
