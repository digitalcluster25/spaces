import React from "react";
import ReactDOM from "react-dom/client";
import {
  ArrowRight,
  Bot,
  BrainCircuit,
  Check,
  Command,
  ExternalLink,
  Fingerprint,
  KeyRound,
  Layers3,
  LockKeyhole,
  Mail,
  MessageSquareText,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { createClient, type Session } from "@supabase/supabase-js";
import "./styles.css";

type AuthMode = "login" | "register" | "forgot";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const authReady = Boolean(supabaseUrl && supabaseAnonKey);
const supabase = authReady ? createClient(supabaseUrl!, supabaseAnonKey!) : null;

type ConnectedService = {
  id: string;
  name: string;
  description: string;
  status: string;
  uiUrl: string;
  mcpUrl?: string;
};

const services = [
  "CRM",
  "Analytics",
  "Docs",
  "Billing",
  "Support",
  "Tasks",
  "Marketing",
  "Inventory",
];

const connectedServices: ConnectedService[] = [
  {
    id: "openseo",
    name: "OpenSEO",
    description: "SEO workflows, DataForSEO, Google Search Console and AI/MCP access.",
    status: "MCP ready, SSO next",
    uiUrl: "https://openseo.spaces.community",
    mcpUrl: "https://openseo.spaces.community/mcp",
  },
  {
    id: "outline",
    name: "Outline",
    description: "База знаний Spaces, проектная документация и внутренние инструкции.",
    status: "Docs ready",
    uiUrl: "https://outline.spaces.community/",
  },
];

function App() {
  const path = window.location.pathname;
  const authMode: AuthMode | null =
    path === "/login" ? "login" : path === "/register" ? "register" : path === "/forgot" ? "forgot" : null;

  return (
    <main>
      <TopBar />
      {path === "/account" ? (
        <AccountPage />
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

function TopBar() {
  const [session, setSession] = React.useState<Session | null>(null);

  React.useEffect(() => {
    if (!supabase) {
      return;
    }

    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession));

    return () => subscription.unsubscribe();
  }, []);

  const userName =
    session?.user.user_metadata?.name ||
    session?.user.user_metadata?.full_name ||
    session?.user.email ||
    "Пользователь";
  const avatarUrl = session?.user.user_metadata?.avatar_url as string | undefined;
  const initials = userName.slice(0, 1).toUpperCase();

  return (
    <header className="topbar">
      <a className="brand" href="/" aria-label="Spaces home">
        <span className="brandMark">
          <Command size={20} />
        </span>
        <span>Spaces</span>
      </a>
      <div className="topActions">
        {session ? (
          <>
            <span className="userAvatar" aria-label={userName}>
              {avatarUrl ? <img src={avatarUrl} alt="" /> : initials}
            </span>
            <a className="outlineButton shadowButton" href="/account">
              Профиль
            </a>
          </>
        ) : (
          <>
            <a className="ghostButton" href="/login">
              Войти
            </a>
            <a className="solidButton" href="/register">
              Начать
            </a>
          </>
        )}
      </div>
    </header>
  );
}

function Landing() {
  return (
    <>
      <section className="hero">
        <div className="heroCopy">
          <div className="eyebrow">
            <Sparkles size={16} />
            единый аккаунт для экосистемы сервисов
          </div>
          <h1>Spaces управляет всеми сервисами проекта из одного AI-чата.</h1>
          <p>
            Главный сайт объединяет десятки рабочих инструментов на субдоменах: один профиль, единые права,
            общий контекст и помощник, который понимает данные каждого подключенного сервиса.
            Spaces is the main account hub for project services, authentication, access control, and AI-assisted
            service management.
          </p>
          <div className="heroActions">
            <a className="solidButton large" href="/register">
              Создать аккаунт
              <ArrowRight size={18} />
            </a>
            <a className="outlineButton large" href="/login">
              Войти в Spaces
            </a>
          </div>
        </div>
        <div className="consolePanel" aria-label="AI workspace preview">
          <div className="consoleHeader">
            <span />
            <span />
            <span />
          </div>
          <div className="assistantCard">
            <div className="assistantIcon">
              <Bot size={22} />
            </div>
            <div>
              <strong>AI-оператор Spaces</strong>
              <p>Покажи просроченные задачи, проверь оплату и подготовь отчет по сервисам за неделю.</p>
            </div>
          </div>
          <div className="serviceGrid">
            {services.map((service) => (
              <div className="serviceTile" key={service}>
                <Check size={16} />
                {service}
              </div>
            ))}
          </div>
          <div className="contextBar">
            <BrainCircuit size={18} />
            <span>Контекст найден в базе знаний и сервисных данных аккаунта</span>
          </div>
        </div>
      </section>
    </>
  );
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
  const lead = isLogin
    ? "Один вход для всех сервисов экосистемы."
    : isRegister
      ? "Зарегистрируйтесь, чтобы подключать сервисы и управлять ими через AI."
      : "Укажите email, и Spaces отправит ссылку для сброса пароля.";

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage("");

    if (!supabase) {
      setLoading(false);
      setMessage("Auth backend еще не подключен. Добавьте VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY.");
      return;
    }

    const accountRedirect = `${window.location.origin}/account`;
    const resetRedirect = `${window.location.origin}/reset-password`;
    const result = isLogin
      ? await supabase.auth.signInWithPassword({ email, password })
      : isRegister
        ? await supabase.auth.signUp({ email, password, options: { data: { name }, emailRedirectTo: accountRedirect } })
        : await supabase.auth.resetPasswordForEmail(email, { redirectTo: resetRedirect });

    setLoading(false);
    if (result.error) {
      setMessage(result.error.message);
      return;
    }

    if (isLogin) {
      window.location.assign("/account");
      return;
    }

    setMessage(isRegister ? "Аккаунт создан. Проверьте email, если подтверждение включено." : "Проверьте email.");
  }

  async function handleGoogleAuth() {
    if (!supabase) {
      setMessage("Google OAuth будет доступен после подключения Supabase.");
      return;
    }

    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/account`,
      },
    });
  }

  return (
    <section className="authShell">
      <div className="authAside">
        <div className="eyebrow">
          <KeyRound size={16} />
          secure access
        </div>
        <h1>{title}</h1>
        <p>{lead}</p>
        <div className="authPromise">
          <ShieldCheck size={20} />
          <span>Единый аккаунт, Google OAuth и восстановление доступа подготовлены в одном модуле.</span>
        </div>
      </div>

      <form className="authForm" onSubmit={handleSubmit}>
        {isRegister && (
          <label>
            Имя
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Андрей" autoComplete="name" />
          </label>
        )}
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@company.com"
            autoComplete="email"
            required
          />
        </label>
        {mode !== "forgot" && (
          <label>
            Пароль
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Минимум 8 символов"
              autoComplete={isLogin ? "current-password" : "new-password"}
              minLength={8}
              required
            />
          </label>
        )}
        <button className="solidButton full" type="submit" disabled={loading}>
          {loading ? "Подождите..." : isLogin ? "Войти" : isRegister ? "Зарегистрироваться" : "Отправить ссылку"}
        </button>
        {mode !== "forgot" && (
          <button className="googleButton" type="button" onClick={handleGoogleAuth}>
            <Mail size={18} />
            Продолжить с Google
          </button>
        )}
        {message && <p className="formMessage">{message}</p>}
        <div className="authLinks">
          {!isLogin && <a href="/login">Уже есть аккаунт</a>}
          {!isRegister && <a href="/register">Создать аккаунт</a>}
          {mode !== "forgot" && <a href="/forgot">Напомнить пароль</a>}
        </div>
      </form>
    </section>
  );
}

function AccountPage() {
  const [session, setSession] = React.useState<Session | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => subscription.unsubscribe();
  }, []);

  async function handleSignOut() {
    if (!supabase) {
      return;
    }

    await supabase.auth.signOut();
    window.location.assign("/");
  }

  return (
    <section className="authShell">
      <div className="authAside">
        <div className="eyebrow">
          <Fingerprint size={16} />
          account hub
        </div>
        <h1>Аккаунт Spaces</h1>
        <p>Здесь будет единый профиль пользователя, доступы ко всем сервисам и управление через AI.</p>
      </div>

      <div className="accountPanel">
        {!authReady ? (
          <>
            <h2>Supabase не подключен</h2>
            <p>Нужны `VITE_SUPABASE_URL` и `VITE_SUPABASE_ANON_KEY` в окружении сборки.</p>
          </>
        ) : loading ? (
          <p>Проверяем сессию...</p>
        ) : session ? (
          <>
            <h2>Вход выполнен</h2>
            <p>{session.user.email}</p>
            <div className="securityList compact">
              <div>
                <ShieldCheck size={20} />
                <span>Сессия активна</span>
              </div>
              <div>
                <Layers3 size={20} />
                <span>Профиль готов к связке с сервисами</span>
              </div>
            </div>
            <button className="outlineButton full" type="button" onClick={handleSignOut}>
              Выйти
            </button>
          </>
        ) : (
          <>
            <h2>Нужно войти</h2>
            <p>После авторизации здесь появится единый аккаунт Spaces.</p>
            <a className="solidButton full" href="/login">
              Войти
            </a>
          </>
        )}
        <ServiceDirectory session={session} />
        <ExternalAgentPanel />
      </div>
    </section>
  );
}

function ServiceDirectory({ session }: { session: Session | null }) {
  function launchService(serviceUrl: string) {
    if (!session) {
      window.location.assign("/login");
      return;
    }

    const secondsLeft = Math.max(60, Math.floor((session.expires_at ?? Date.now() / 1000 + 3600) - Date.now() / 1000));
    document.cookie = `spaces_access_token=${session.access_token}; Domain=.spaces.community; Path=/; Max-Age=${secondsLeft}; Secure; SameSite=Lax`;
    window.location.assign(serviceUrl);
  }

  return (
    <section className="serviceDirectory" aria-label="Подключенные сервисы">
      <div>
        <span className="sectionKicker">services</span>
        <h3>Подключенные сервисы</h3>
      </div>
      {connectedServices.map((service) => (
        <article className="connectedService" key={service.id}>
          <div>
            <div className="serviceTitle">
              <strong>{service.name}</strong>
              <span>{service.status}</span>
            </div>
            <p>{service.description}</p>
          </div>
          <div className="serviceActions">
            {session ? (
              <button className="outlineButton" type="button" onClick={() => launchService(service.uiUrl)}>
                Открыть
                <ExternalLink size={16} />
            </button>
          ) : (
            <a className="outlineButton" href="/login">
                Открыть
                <ExternalLink size={16} />
              </a>
            )}
            {service.mcpUrl && (
              <a className="ghostButton" href={service.mcpUrl}>
                MCP
              </a>
            )}
          </div>
        </article>
      ))}
    </section>
  );
}

function ExternalAgentPanel() {
  return (
    <section className="aiControlPanel" aria-label="MCP для внешних агентов">
      <div className="chatHeader">
        <div>
          <span className="sectionKicker">agent access</span>
          <h3>MCP для внешних агентов</h3>
        </div>
        <span className="chatStatus">first</span>
      </div>
      <div className="chatThread">
        <div className="chatMessage assistant">
          <MessageSquareText size={18} />
          <p>Сначала подключаем внешних агентов к сервисам через MCP. Собственный чат Spaces добавим после обкатки.</p>
        </div>
        <div className="chatMessage user">
          <p>Первый сервис: OpenSEO.</p>
        </div>
        <div className="chatMessage assistant">
          <MessageSquareText size={18} />
          <p>OpenSEO SSO работает через Spaces/Supabase. Следующий шаг - выдать агентам управляемый MCP-доступ.</p>
        </div>
      </div>
    </section>
  );
}

function ResetPasswordPage() {
  const [password, setPassword] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage("");

    if (!supabase) {
      setLoading(false);
      setMessage("Auth backend еще не подключен. Добавьте VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY.");
      return;
    }

    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessage("Пароль обновлен.");
    window.setTimeout(() => window.location.assign("/account"), 700);
  }

  return (
    <section className="authShell">
      <div className="authAside">
        <div className="eyebrow">
          <LockKeyhole size={16} />
          password reset
        </div>
        <h1>Новый пароль</h1>
        <p>Этот экран открывается из письма Supabase после запроса восстановления доступа.</p>
      </div>

      <form className="authForm" onSubmit={handleSubmit}>
        <label>
          Новый пароль
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Минимум 8 символов"
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>
        <button className="solidButton full" type="submit" disabled={loading}>
          {loading ? "Сохраняем..." : "Обновить пароль"}
        </button>
        {message && <p className="formMessage">{message}</p>}
      </form>
    </section>
  );
}

function LegalPage({ type }: { type: "privacy" | "terms" }) {
  const isPrivacy = type === "privacy";

  return (
    <section className="legalPage">
      <div className="eyebrow">
        <ShieldCheck size={16} />
        Spaces legal
      </div>
      <h1>{isPrivacy ? "Privacy Policy" : "Terms of Service"}</h1>
      <p className="legalLead">
        {isPrivacy
          ? "Spaces uses one account to connect project services and AI-assisted workflows."
          : "These terms define the first public access rules for Spaces while the platform is being built."}
      </p>
      <div className="legalContent">
        {isPrivacy ? (
          <>
            <h2>Data We Process</h2>
            <p>
              Spaces stores account data such as email, display name, authentication provider, service access, and
              operational records required to run connected services.
            </p>
            <h2>Authentication</h2>
            <p>
              Spaces uses Supabase Auth for email/password login, password recovery, and Google sign-in. Google may share
              your profile name, avatar, and email after consent.
            </p>
            <h2>AI Access</h2>
            <p>
              AI features must only access data allowed for the current user and account. Vector search is used for
              retrieval, not as the only source of truth for account or permission data.
            </p>
            <h2>Contact</h2>
            <p>For privacy questions, contact digitalcluster25@gmail.com.</p>
          </>
        ) : (
          <>
            <h2>Access</h2>
            <p>
              Spaces is an early-stage platform. Access may be limited while account, AI, and service-management modules
              are developed.
            </p>
            <h2>Acceptable Use</h2>
            <p>
              Users must not attempt to bypass authentication, access data that is not theirs, or abuse connected
              services and automation.
            </p>
            <h2>Service Changes</h2>
            <p>
              Spaces may change features, connected services, and availability as the project evolves.
            </p>
            <h2>Contact</h2>
            <p>For terms questions, contact digitalcluster25@gmail.com.</p>
          </>
        )}
      </div>
    </section>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
