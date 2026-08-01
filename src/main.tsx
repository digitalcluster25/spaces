import React from "react";
import ReactDOM from "react-dom/client";
import {
  ArrowRight,
  Bot,
  BrainCircuit,
  Check,
  ChevronRight,
  Command,
  Fingerprint,
  Globe2,
  KeyRound,
  Layers3,
  LockKeyhole,
  Mail,
  Network,
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
  return (
    <header className="topbar">
      <a className="brand" href="/" aria-label="Spaces home">
        <span className="brandMark">
          <Command size={20} />
        </span>
        <span>Spaces</span>
      </a>
      <nav aria-label="Главная навигация">
        <a href="/#platform">Платформа</a>
        <a href="/#ai">AI</a>
        <a href="/#security">Доступ</a>
      </nav>
      <div className="topActions">
        <a className="ghostButton" href="/login">
          Войти
        </a>
        <a className="solidButton" href="/register">
          Начать
        </a>
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

      <section className="sectionBand" id="platform">
        <div className="sectionIntro">
          <span className="sectionKicker">архитектура</span>
          <h2>Главная точка входа для всех будущих сервисов.</h2>
        </div>
        <div className="featureGrid">
          <FeatureCard icon={<Globe2 />} title="Сервисы на субдоменах">
            Каждый продукт живет отдельно, но использует общий аккаунт, роли и навигацию Spaces.
          </FeatureCard>
          <FeatureCard icon={<Fingerprint />} title="Одна идентичность">
            Пользователь регистрируется один раз и получает доступ ко всем разрешенным инструментам.
          </FeatureCard>
          <FeatureCard icon={<Network />} title="Общий контекст">
            Сервисы передают данные в управляемый слой знаний, чтобы AI видел актуальную картину.
          </FeatureCard>
        </div>
      </section>

      <section className="splitSection" id="ai">
        <div>
          <span className="sectionKicker">AI control layer</span>
          <h2>Чат не просто отвечает. Он выполняет действия в рамках прав аккаунта.</h2>
          <p>
            Spaces проектируется как операционная панель: пользователь пишет задачу обычным языком, а AI
            подбирает нужный сервис, проверяет данные и предлагает следующий шаг.
          </p>
        </div>
        <div className="steps">
          <Step number="01" title="Понимает запрос" />
          <Step number="02" title="Находит данные через поиск и сервисные API" />
          <Step number="03" title="Проверяет права пользователя" />
          <Step number="04" title="Готовит действие или результат" />
        </div>
      </section>

      <section className="securitySection" id="security">
        <div className="securityCopy">
          <span className="sectionKicker">security first</span>
          <h2>Доступ AI будет ограничен правами пользователя.</h2>
          <p>
            Основные данные аккаунтов, ролей, оплат и состояния сервисов должны храниться в структурной базе.
            Векторная база используется для семантического поиска, базы знаний и retrieval.
          </p>
        </div>
        <div className="securityList">
          <div>
            <ShieldCheck size={20} />
            <span>Ролевой доступ</span>
          </div>
          <div>
            <LockKeyhole size={20} />
            <span>Контроль токенов и сессий</span>
          </div>
          <div>
            <Layers3 size={20} />
            <span>Разделение данных и AI-индекса</span>
          </div>
        </div>
      </section>
    </>
  );
}

function FeatureCard({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <article className="featureCard">
      <div className="featureIcon">{icon}</div>
      <h3>{title}</h3>
      <p>{children}</p>
    </article>
  );
}

function Step({ number, title }: { number: string; title: string }) {
  return (
    <div className="step">
      <span>{number}</span>
      <strong>{title}</strong>
      <ChevronRight size={18} />
    </div>
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
