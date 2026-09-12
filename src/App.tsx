import React from "react";
import type { Session } from "@supabase/supabase-js";
import {
  Archive,
  ArrowRight,
  Bot,
  BrainCircuit,
  Check,
  ChevronDown,
  Command,
  Copy,
  ExternalLink,
  Fingerprint,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Mail,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
  Activity,
  Database,
  ServerCog,
  Users,
} from "lucide-react";
import {
  acceptHarnessVersion,
  adminPublishHarness,
  adminRetryJob,
  adminSaveService,
  adminSetAccountStatus,
  adminSetSubscription,
  adminUpdatePlanLimit,
  archiveProject,
  authReady,
  createProject,
  createMcpCredential,
  createServiceTicket,
  loadWorkspace,
  loadAdminData,
  restoreProject,
  revokeMcpCredential,
  saveHarnessUserConfig,
  setActiveProjectForTab,
  setServiceEnabled,
  supabase,
  updateProject,
  type Project,
  type AdminData,
  type PlanLimit,
  type Service,
  type Workspace,
} from "./platform";

type AuthMode = "login" | "register" | "forgot";

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

  const refresh = React.useCallback(async () => {
    if (!session) {
      setWorkspace(null);
      setLoading(false);
      return;
    }
    setLoading(true);
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
  const workspaceState = useWorkspace(session);
  const path = window.location.pathname;
  const authMode: AuthMode | null =
    path === "/login" ? "login" : path === "/register" ? "register" : path === "/forgot" ? "forgot" : null;

  if (session && workspaceState.workspace?.profile.is_superadmin) {
    return (
      <MfaBoundary session={session}>
        <AppContent session={session} authLoading={authLoading} workspaceState={workspaceState} path={path} authMode={authMode} />
      </MfaBoundary>
    );
  }

  return <AppContent session={session} authLoading={authLoading} workspaceState={workspaceState} path={path} authMode={authMode} />;
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

  React.useEffect(() => {
    if (!supabase) return;
    supabase.auth.mfa.getAuthenticatorAssuranceLevel().then(({ data, error }) => {
      setVerified(!error && data.currentLevel === "aal2");
    });
  }, [session.access_token]);

  if (verified === null) return <StatePage loading title="Проверяем защиту аккаунта" text="Подтверждаем второй фактор." />;
  if (!verified) return <MfaSetup onVerified={() => setVerified(true)} />;
  return <>{children}</>;
}

function MfaSetup({ onVerified }: { onVerified: () => void }) {
  const [factorId, setFactorId] = React.useState("");
  const [qrCode, setQrCode] = React.useState("");
  const [secret, setSecret] = React.useState("");
  const [code, setCode] = React.useState("");
  const [mode, setMode] = React.useState<"loading" | "enroll" | "verify">("loading");
  const [message, setMessage] = React.useState("");
  const [working, setWorking] = React.useState(false);

  React.useEffect(() => {
    if (!supabase) return;
    supabase.auth.mfa.listFactors().then(({ data, error }) => {
      if (error) {
        setMessage(error.message);
        setMode("verify");
        return;
      }
      const factor = data.totp.find((item) => item.status === "verified");
      if (factor) {
        setFactorId(factor.id);
        setMode("verify");
      } else {
        setMode("enroll");
      }
    });
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
        {mode === "loading" ? <div className="notice"><LoaderCircle className="spin" size={16} />Проверяем доступные факторы</div> : mode === "enroll" ? (
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

  const name = workspace.profile.display_name || workspace.profile.email || "Пользователь";
  return (
    <header className={`tenantBar${expanded ? " expanded" : ""}`}>
      <div className="tenantMain">
        <Brand />
        <span className="tenantDivider" />
        <div className="tenantIdentity">
          <span className="tenantLabel">Аккаунт</span>
          <strong>{workspace.account.name}</strong>
        </div>
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
      {tab === "audit" && <AuditAdmin data={data} />}
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
    return <AccountAdminRow key={account.id} account={account} owner={owner} planCode={plan?.code ?? "trial"} subscriptionStatus={subscription?.status ?? "trialing"} seats={subscription?.seats ?? 1} plans={data.plans} confirm={confirm} />;
  })}</div>;
}

function AccountAdminRow({ account, owner, planCode, subscriptionStatus, seats, plans, confirm }: { account: AdminData["accounts"][number]; owner?: AdminData["profiles"][number]; planCode: string; subscriptionStatus: string; seats: number; plans: AdminData["plans"]; confirm: (text: string, action: () => Promise<void>) => void }) {
  const [selectedPlan, setSelectedPlan] = React.useState(planCode);
  const [selectedStatus, setSelectedStatus] = React.useState(subscriptionStatus);
  const [seatCount, setSeatCount] = React.useState(seats);
  const saveText = "Изменить тариф аккаунта «" + account.name + "» на " + selectedPlan + ", статус " + selectedStatus + ", мест: " + seatCount + ".";
  const statusText = (account.status === "active" ? "Приостановить" : "Активировать") + " аккаунт «" + account.name + "».";
  return <article className="adminRow"><div><strong>{account.name}</strong><p>{owner?.email ?? account.slug}</p><div className="rowBadges"><span className="badge">{account.account_type}</span><span className={"status status-" + (account.status === "active" ? "ready" : "disabled")}>{account.status}</span></div></div><div className="adminControls"><select value={selectedPlan} onChange={(event) => setSelectedPlan(event.target.value)}>{plans.map((plan) => <option key={plan.id} value={plan.code}>{plan.name}</option>)}</select><select value={selectedStatus} onChange={(event) => setSelectedStatus(event.target.value)}><option value="trialing">trialing</option><option value="active">active</option><option value="past_due">past_due</option><option value="paused">paused</option></select><input type="number" min={1} value={seatCount} onChange={(event) => setSeatCount(Number(event.target.value))} aria-label="Места" /><button className="button buttonOutline" onClick={() => confirm(saveText, () => adminSetSubscription(account.id, selectedPlan, selectedStatus, seatCount))}>Сохранить тариф</button>{!owner?.is_superadmin && <button className="button buttonGhost" onClick={() => confirm(statusText, () => adminSetAccountStatus(account.id, account.status === "active" ? "suspended" : "active"))}>{account.status === "active" ? "Приостановить" : "Активировать"}</button>}</div></article>;
}

function PlansAdmin({ data, confirm }: { data: AdminData; confirm: (text: string, action: () => Promise<void>) => void }) {
  return <div className="planColumns">{data.plans.map((plan) => <section className="planSection" key={plan.id}><div className="sectionHeader"><div><h2>{plan.name}</h2><p>{plan.price_cents ? "$" + (plan.price_cents / 100).toFixed(0) + " / " + (plan.billing_mode === "seat" ? "место" : "аккаунт") : "Системный тариф"}</p></div><code>{plan.code}</code></div><div className="dataList">{data.limits.filter((limit) => limit.plan_id === plan.id).map((limit) => <LimitAdminRow key={limit.key} planCode={plan.code} limit={limit} confirm={confirm} />)}</div></section>)}</div>;
}

function LimitAdminRow({ planCode, limit, confirm }: { planCode: string; limit: PlanLimit; confirm: (text: string, action: () => Promise<void>) => void }) {
  const [value, setValue] = React.useState(limit.value?.toString() ?? "");
  const [status, setStatus] = React.useState<"active" | "reserve">(limit.status);
  const text = "Изменить лимит " + planCode + ":" + limit.key + " на " + (value || "без ограничений") + " (" + status + ").";
  return <div className="limitRow"><div><strong>{limit.description || limit.key}</strong><code>{limit.key}</code></div><input type="number" value={value} placeholder="∞" onChange={(event) => setValue(event.target.value)} /><span>{limit.unit}</span><select value={status} onChange={(event) => setStatus(event.target.value as "active" | "reserve")}><option value="active">active</option><option value="reserve">reserve</option></select><button className="button buttonOutline" onClick={() => confirm(text, () => adminUpdatePlanLimit(planCode, { ...limit, value: value === "" ? null : Number(value), status }))}>Сохранить</button></div>;
}

function ServicesAdmin({ data, confirm }: { data: AdminData; confirm: (text: string, action: () => Promise<void>) => void }) {
  return <div className="dataList">{data.services.map((service) => <ServiceAdminRow key={service.id} service={service} confirm={confirm} />)}</div>;
}

function ServiceAdminRow({ service, confirm }: { service: Service; confirm: (text: string, action: () => Promise<void>) => void }) {
  const [draft, setDraft] = React.useState(service);
  return <article className="adminRow serviceAdminRow"><div><strong>{service.name}</strong><p>{service.slug}</p>{service.is_core && <span className="badge dark">core</span>}</div><div className="serviceAdminFields"><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} aria-label="Название сервиса" /><input value={draft.base_url ?? ""} onChange={(event) => setDraft({ ...draft, base_url: event.target.value })} aria-label="URL сервиса" /><input value={draft.mcp_url ?? ""} onChange={(event) => setDraft({ ...draft, mcp_url: event.target.value || null })} aria-label="MCP URL" /><select value={draft.status} disabled={service.is_core} onChange={(event) => setDraft({ ...draft, status: event.target.value as Service["status"] })}><option value="active">active</option><option value="paused">paused</option><option value="planned">planned</option></select><button className="button buttonOutline" onClick={() => confirm("Сохранить системные настройки сервиса «" + draft.name + "».", () => adminSaveService(draft))}>Сохранить</button></div></article>;
}

function HarnessAdmin({ data, confirm }: { data: AdminData; confirm: (text: string, action: () => Promise<void>) => void }) {
  const latest = data.harnessVersions[0];
  const [config, setConfig] = React.useState(JSON.stringify(latest?.admin_config ?? {}, null, 2));
  const [error, setError] = React.useState("");
  function preparePublish() {
    try {
      const parsed = JSON.parse(config) as Record<string, unknown>;
      setError("");
      confirm("Опубликовать новую неизменяемую версию Harness после успешного контрольного прогона. Пользователям обновление будет только предложено.", () => adminPublishHarness(parsed, { passed: true, source: "superadminko-manual-check" }));
    } catch {
      setError("Конфигурация должна быть корректным JSON.");
    }
  }
  return <section className="adminEditor"><div className="sectionHeader"><div><h2>Административный слой Harness</h2><p>Текущая опубликованная версия: v{latest?.version ?? "—"}. Публикация создаёт новую версию, старую не изменяет.</p></div><button className="button buttonPrimary" onClick={preparePublish}>Проверить и опубликовать</button></div><label>Конфигурация<textarea className="jsonEditor" value={config} onChange={(event) => setConfig(event.target.value)} /></label>{error && <div className="notice errorNotice">{error}</div>}</section>;
}

function JobsAdmin({ data, confirm }: { data: AdminData; confirm: (text: string, action: () => Promise<void>) => void }) {
  return <div className="dataList">{data.jobs.length ? data.jobs.map((job) => <article className="adminRow" key={job.id}><div><strong>{job.operation}</strong><p>{job.project_service_id}</p><span className={"status status-" + (job.status === "completed" ? "ready" : job.status === "failed" ? "error" : "disabled")}>{job.status}</span>{job.last_error && <small className="fieldError">{job.last_error}</small>}</div>{job.status === "failed" && <button className="button buttonOutline" onClick={() => confirm("Повторно поставить операцию " + job.operation + " в очередь.", () => adminRetryJob(job.id))}>Повторить</button>}</article>) : <div className="emptyState">Очередь provisioning пуста.</div>}</div>;
}

function AuditAdmin({ data }: { data: AdminData }) {
  return <div className="tableWrap"><table className="dataTable"><thead><tr><th>Время</th><th>Действие</th><th>Проект</th><th>Объект</th></tr></thead><tbody>{data.audit.map((event) => <tr key={event.id}><td>{new Date(event.created_at).toLocaleString("ru")}</td><td><code>{event.action}</code></td><td>{event.project_id ?? "—"}</td><td>{event.target_type ? event.target_type + ": " + event.target_id : "—"}</td></tr>)}</tbody></table></div>;
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
        <button className="button buttonPrimary" type="button" onClick={() => setDialog({ mode: "create" })}><Plus size={16} />Создать проект</button>
      </div>

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
              {project.status === "active" ? (
                <>
                  <button className="iconButton" title="Изменить" disabled={project.is_system} onClick={() => setDialog({ mode: "edit", project })}><Pencil size={16} /></button>
                  <button className="iconButton" title="Архивировать" disabled={project.is_system} onClick={() => setConfirmProject(project)}><Archive size={16} /></button>
                </>
              ) : (
                <button className="button buttonOutline" disabled={working} onClick={() => void restore(project)}><RotateCcw size={15} />Восстановить</button>
              )}
            </div>
          </article>
        ))}
        {!visibleProjects.length && <div className="emptyState">В этом разделе пока нет проектов.</div>}
      </div>

      {activeProject?.status === "active" && <ProjectWorkspace session={session} project={activeProject} workspace={workspace} refresh={refresh} />}
      {dialog && <ProjectDialog state={dialog} services={workspace.services} onClose={() => setDialog(null)} onSaved={async () => { setDialog(null); await refresh(); }} />}
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

function ProjectLogo({ project }: { project: Project }) {
  return <span className="projectLogo">{project.logo_url ? <img src={project.logo_url} alt="" /> : project.name.slice(0, 1).toUpperCase()}</span>;
}

function ProjectWorkspace({ session, project, workspace, refresh }: { session: Session; project: Project; workspace: Workspace; refresh: () => Promise<void> }) {
  const connections = workspace.projectServices.filter((item) => item.project_id === project.id);
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
                <label className="switch"><input type="checkbox" checked={Boolean(enabled)} onChange={(event) => void toggle(service, event.target.checked)} /><span /></label>
                {connection?.status === "ready" ? <a className="button buttonOutline" href={serviceLaunchHref(project.id, service.slug)} target="_blank" rel="noopener noreferrer">Открыть<ExternalLink size={15} /></a> : <button className="button buttonOutline" type="button" disabled>Открыть<ExternalLink size={15} /></button>}
                {service.mcp_url && connection?.status === "ready" && <a className="button buttonGhost" href="#mcp-access">MCP<KeyRound size={14} /></a>}
              </div>
            </article>
          );
        })}
      </div>
      <McpPanel project={project} workspace={workspace} refresh={refresh} />
      <HarnessPanel project={project} workspace={workspace} refresh={refresh} />
    </div>
  );
}

function McpPanel({ project, workspace, refresh }: { project: Project; workspace: Workspace; refresh: () => Promise<void> }) {
  const credentials = workspace.mcpCredentials.filter((credential) => credential.project_id === project.id);
  const [name, setName] = React.useState("");
  const [lifetime, setLifetime] = React.useState("90");
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
      const credential = await createMcpCredential(project.id, name, expiresAt);
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

  return (
    <section className="mcpPanel" id="mcp-access">
      <div className="sectionHeader">
        <div><span className="sectionKicker"><KeyRound size={14} />agent access</span><h2>MCP-доступ проекта</h2><p>Отдельный отзывной ключ для каждого внешнего агента. Ключ даёт доступ только к OpenSEO этого проекта.</p></div>
      </div>
      <div className="mcpEndpoint"><span>Endpoint</span><code>https://openseo.spaces.community/mcp</code><button className="iconButton" type="button" title="Копировать endpoint" onClick={() => void copy("https://openseo.spaces.community/mcp")}><Copy size={15} /></button></div>
      <div className="mcpCreate">
        <label>Название ключа<input value={name} maxLength={80} placeholder="Например, Codex на MacBook" onChange={(event) => setName(event.target.value)} /></label>
        <label>Срок действия<select value={lifetime} onChange={(event) => setLifetime(event.target.value)}><option value="30">30 дней</option><option value="90">90 дней</option><option value="365">1 год</option><option value="permanent">Без срока</option></select></label>
        <button className="button buttonPrimary" type="button" disabled={working || !name.trim()} onClick={() => void create()}>Создать ключ</button>
      </div>
      {revealed && <div className="secretReveal"><div><strong>{revealed.name}</strong><p>Сохраните ключ сейчас. После закрытия он больше не будет показан.</p></div><code>{revealed.token}</code><button className="button buttonOutline" type="button" onClick={() => void copy(revealed.token)}><Copy size={15} />Копировать</button><button className="iconButton" type="button" title="Скрыть ключ" onClick={() => setRevealed(null)}><X size={15} /></button></div>}
      {message && <div className="notice">{message}</div>}
      <div className="credentialList">
        {credentials.map((credential) => {
          const expired = Boolean(credential.expires_at && new Date(credential.expires_at).getTime() <= Date.now());
          const active = !credential.revoked_at && !expired;
          return <div className="credentialRow" key={credential.id}><div><strong>{credential.name}</strong><small>{active ? "Активен" : credential.revoked_at ? "Отозван" : "Истёк"} · {credential.expires_at ? `до ${new Date(credential.expires_at).toLocaleDateString("ru")}` : "без срока"}{credential.last_used_at ? ` · использован ${new Date(credential.last_used_at).toLocaleString("ru")}` : " · ещё не использован"}</small></div><code>openseo:*</code>{active && <button className="iconButton" type="button" title="Отозвать ключ" onClick={() => setRevokeTarget(credential.id)}><Trash2 size={15} /></button>}</div>;
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

function HarnessPanel({ project, workspace, refresh }: { project: Project; workspace: Workspace; refresh: () => Promise<void> }) {
  const initial = workspace.harness?.user_config ?? {};
  const [config, setConfig] = React.useState<Record<string, unknown>>(initial);
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const fields = [
    ["system_context", "Системный контекст", "Цели, терминология и важные ограничения проекта"],
    ["acceptance_criteria", "Критерии результата", "Как проверить, что задача выполнена полностью"],
    ["accuracy_rules", "Требования к точности", "Источники, перепроверка и допустимая неопределённость"],
    ["response_preferences", "Предпочтения ответа", "Язык, тон, формат и степень подробности"],
  ] as const;

  React.useEffect(() => setConfig(initial), [workspace.harness?.project_id, workspace.harness?.user_config]);

  async function save() {
    setSaving(true);
    setMessage("");
    try {
      await saveHarnessUserConfig(project.id, config);
      await refresh();
      setMessage("Настройки сохранены.");
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

  return (
    <section className="harnessPanel">
      <div className="sectionHeader"><div><span className="sectionKicker"><Settings2 size={14} />harness</span><h2>Настройки среды</h2><p>Административный слой задаёт обязательные правила. Пользовательский слой дополняет их и не может ослабить безопасность.</p></div><span className="badge dark">v{workspace.harnessVersion?.version ?? "—"}</span></div>
      {workspace.harness?.offered_version_id && <div className="notice updateNotice"><span>Доступна новая версия административного шаблона. Она будет применена только после подтверждения.</span><button className="button buttonOutline" onClick={() => void acceptUpdate()}>Применить</button></div>}
      <div className="harnessGrid">
        {fields.map(([key, label, placeholder]) => <label key={key}>{label}<textarea value={String(config[key] ?? "")} onChange={(event) => setConfig((current) => ({ ...current, [key]: event.target.value }))} placeholder={placeholder} /></label>)}
      </div>
      <div className="notice"><ShieldCheck size={16} />Обязательные правила безопасности, изоляции проекта и проверки результата применяются без изменений.</div>
      {workspace.harness?.conflict_report?.map((conflict, index) => <div className="notice errorNotice" key={index}>{conflict.field}: {conflict.reason}</div>)}
      {message && <div className="notice">{message}</div>}
      <div className="harnessActions"><button className="button buttonPrimary" disabled={saving} onClick={() => void save()}>{saving ? "Сохраняем..." : "Сохранить настройки"}</button></div>
    </section>
  );
}

function ProjectDialog({ state, services, onClose, onSaved }: { state: { mode: "create" | "edit"; project?: Project }; services: Service[]; onClose: () => void; onSaved: () => Promise<void> }) {
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
      if (state.mode === "create") await createProject({ name, description, logoUrl, services: selectedServices });
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
        ? await supabase.auth.signUp({ email, password, options: { data: { name }, emailRedirectTo: `${window.location.origin}/account` } })
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
