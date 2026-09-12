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
  X,
} from "lucide-react";
import {
  acceptHarnessVersion,
  archiveProject,
  authReady,
  createProject,
  loadWorkspace,
  restoreProject,
  saveHarnessUserConfig,
  setActiveProject,
  setServiceEnabled,
  supabase,
  updateProject,
  type Project,
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

  return (
    <main>
      {header}
      {path === "/account" ? (
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
    await setActiveProject(projectId);
    await onRefresh();
  }

  function launch(service: Service) {
    if (!activeProject || !service.base_url) return;
    const secondsLeft = Math.max(60, Math.floor((session.expires_at ?? Date.now() / 1000 + 3600) - Date.now() / 1000));
    document.cookie = `spaces_access_token=${session.access_token}; Domain=.spaces.community; Path=/; Max-Age=${secondsLeft}; Secure; SameSite=Lax`;
    document.cookie = `spaces_project_id=${activeProject.id}; Domain=.spaces.community; Path=/; Max-Age=${secondsLeft}; Secure; SameSite=Lax`;
    const url = service.slug === "outline"
      ? `${service.base_url}/spaces-sso?next=/home&project=${encodeURIComponent(activeProject.id)}`
      : service.base_url;
    window.open(url, "_blank", "noopener,noreferrer");
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
          return <button key={service.id} type="button" onClick={() => launch(service)}>{service.name}<ExternalLink size={13} /></button>;
        })}
      </nav>
      <a className="tenantProfile" href="/account">
        <Avatar name={name} url={workspace.profile.avatar_url} />
        <span>{name}</span>
      </a>
    </header>
  );
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

  async function chooseProject(project: Project) {
    await setActiveProject(project.id);
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

  function launch(service: Service) {
    if (!service.base_url) return;
    const secondsLeft = Math.max(60, Math.floor((session.expires_at ?? Date.now() / 1000 + 3600) - Date.now() / 1000));
    document.cookie = `spaces_access_token=${session.access_token}; Domain=.spaces.community; Path=/; Max-Age=${secondsLeft}; Secure; SameSite=Lax`;
    document.cookie = `spaces_project_id=${project.id}; Domain=.spaces.community; Path=/; Max-Age=${secondsLeft}; Secure; SameSite=Lax`;
    const url = service.slug === "outline" ? `${service.base_url}/spaces-sso?next=/home&project=${project.id}` : service.base_url;
    window.open(url, "_blank", "noopener,noreferrer");
  }

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
                <button className="button buttonOutline" type="button" disabled={connection?.status !== "ready"} onClick={() => launch(service)}>Открыть<ExternalLink size={15} /></button>
                {service.mcp_url && connection?.status === "ready" && <a className="button buttonGhost" href={service.mcp_url} target="_blank" rel="noreferrer">MCP<ExternalLink size={14} /></a>}
              </div>
            </article>
          );
        })}
      </div>
      <HarnessPanel project={project} workspace={workspace} refresh={refresh} />
    </div>
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
    if (isLogin) return window.location.assign("/account");
    setMessage(isRegister ? "Аккаунт создан. Проверьте почту для подтверждения." : "Ссылка отправлена. Проверьте почту.");
  }

  async function googleAuth() {
    if (!supabase) return setMessage("Авторизация не подключена.");
    const { error } = await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: `${window.location.origin}/account` } });
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
