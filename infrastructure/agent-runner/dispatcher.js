// SPC-0018: restricted agent runner for the Spaces project.
//
// Paca automation (card → «Беклог» / «На доработку агенту») → POST /spaces-agents/hook
// → this dispatcher re-reads the card and runs ONE task at a time:
//   1. clones the repo into a fresh working copy owned by the unprivileged agent user;
//   2. starts Claude Code as that user WITHOUT bypass: only allowlisted tools
//      (file read/edit in the working copy, npm build/test, git status/diff/add/commit),
//      everything else is denied without a prompt (--permission-mode dontAsk);
//   3. re-runs build + unit tests itself (the agent's own claims are not trusted);
//   4. moves the agent's commits into a root-owned clean clone as patches and pushes
//      ONLY a branch spc-<N> with the deploy key; never main, never --force;
//   5. comments the result + compare link in Paca, appends a checkpoint to the spec
//      in Outline and moves the card to «На утверждение» (or «Застрял»).
// The agent process never receives Paca/Outline/GitHub/Supabase credentials.
// Merge to main and the production check stay with the owner.
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const env = process.env;
const config = {
  port: Number(env.PORT || 3000),
  hookSecret: env.AGENT_HOOK_SECRET,
  pacaUrl: (env.PACA_INTERNAL_URL || "http://gateway:80").replace(/\/$/, ""),
  pacaApiKey: env.PACA_API_KEY,
  pacaProjectId: env.PACA_PROJECT_ID || "97b9ffcc-116e-4625-9c0a-e82651d6dd0f",
  spacesProjectId: env.SPACES_PROJECT_ID || "f1857726-60e0-42ee-afd0-67b893f1ef6d",
  supabaseUrl: env.SUPABASE_URL,
  supabaseAnonKey: env.SUPABASE_ANON_KEY,
  runnerSecret: env.AGENT_RUNNER_SECRET,
  outlineUrl: (env.OUTLINE_URL || "https://outline.spaces.community").replace(/\/$/, ""),
  outlineApiKey: env.OUTLINE_API_KEY,
  claudeToken: env.CLAUDE_CODE_OAUTH_TOKEN,
  repoUrl: env.REPO_URL || "https://github.com/digitalcluster25/spaces.git",
  pushUrl: env.PUSH_URL || "git@github.com:digitalcluster25/spaces.git",
  compareBase: env.COMPARE_BASE || "https://github.com/digitalcluster25/spaces/compare/main...",
  deployKey: env.DEPLOY_KEY_PATH || "/run/agent-secrets/deploy_key",
  knownHosts: env.KNOWN_HOSTS_PATH || "/run/agent-secrets/known_hosts",
  workRoot: env.WORK_ROOT || "/work",
  // pwuser is remapped in the image to uid/gid 20001 — no such user on the host.
  agentUid: Number(env.AGENT_UID || 20001),
  agentGid: Number(env.AGENT_GID || 20001),
  previewUrl: (env.PREVIEW_URL || "https://preview.spaces.community").replace(/\/$/, ""),
  previewMinutes: Number(env.PREVIEW_MAX_MINUTES || 20),
  agentHome: env.AGENT_HOME || "/home/pwuser",
  agentMinutes: Number(env.AGENT_MAX_MINUTES || 90),
  maxTurns: Number(env.AGENT_MAX_TURNS || 200),
  status: {
    review: env.STATUS_REVIEW || "0e199ff4-7e61-4c67-93ae-bc07de980968", // На утверждение
    rework: env.STATUS_REWORK || "f850de0e-9ebf-447a-8491-fee3a24afe10", // На доработку агенту
    backlog: env.STATUS_BACKLOG || "cf2a571c-4f81-489c-9a90-696460f77f85", // Беклог
    inProgress: env.STATUS_IN_PROGRESS || "7a14e900-6069-4814-906f-a83a00577b3e", // В процессе
    stuck: env.STATUS_STUCK || "e9a95f22-4d74-4c42-9f7a-71ea959764c2", // Застрял
    accepted: env.STATUS_ACCEPTED || "e3968549-7a36-462b-aa64-cca8955ce49a", // Принято
    done: env.STATUS_DONE || "dd4fbd7f-1f12-42c1-9864-454c720aeb11", // Готово
  },
  // SPC-0020: only these people may accept (merge + production). Paca users are matched by email.
  approverEmails: String(env.APPROVER_EMAILS || "digitalcluster25@gmail.com").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean),
  releaseStatusFile: env.RELEASE_STATUS_FILE || "/run/release-status/status.json",
  productionUrl: (env.PRODUCTION_URL || "https://spaces.community").replace(/\/$/, ""),
  releaseMinutes: Number(env.RELEASE_MAX_MINUTES || 30),
};

// Tools the agent may use. Anything not listed is denied without a prompt.
const ALLOWED_TOOLS = [
  "Read", "Edit", "Write", "Glob", "Grep", "TodoWrite",
  "Bash(npm ci)", "Bash(npm run build)", "Bash(npm test)", "Bash(npm run test:*)",
  "Bash(npx playwright test:*)", "Bash(npx tsc:*)", "Bash(node --test:*)",
  "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)",
  "Bash(git add:*)", "Bash(git commit:*)", "Bash(ls:*)",
];
const DISALLOWED_TOOLS = [
  "WebFetch", "WebSearch", "Task", "NotebookEdit",
  "Bash(git push:*)", "Bash(git remote:*)", "Bash(git config:*)", "Bash(curl:*)", "Bash(wget:*)",
  "Bash(ssh:*)", "Bash(npm install:*)", "Bash(npx supabase:*)", "Bash(supabase:*)",
];
// Changes here are flagged for the owner's attention in the review comment.
const SENSITIVE_PATHS = [/^supabase\//, /^infrastructure\//, /^scripts\//, /^\.github\//, /^package(-lock)?\.json$/, /^AGENTS\.md$/, /^harness\//];
const BRANCH_PATTERN = /^spc-\d+$/;
// The only other branch the runner writes: preview = main + the current task (SPC-0020).
const STAGE_BRANCH = "stage";
const AGENT_NAME = "Spaces agent (Claude Code)";
const AGENT_EMAIL = "agents@spaces.community";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

// --- BlockNote helpers ------------------------------------------------------------

function blocksToText(blocks) {
  if (typeof blocks === "string") return blocks;
  if (!Array.isArray(blocks)) return "";
  const lines = [];
  const inline = (items) => (items || []).map((item) => {
    if (item.type === "link") return `${inline(item.content)} (${item.href})`;
    return item.text || "";
  }).join("");
  const walk = (list, depth) => {
    for (const block of list) {
      let text = Array.isArray(block.content) ? inline(block.content) : "";
      if (block.type === "heading") text = `${"#".repeat(block.props?.level || 2)} ${text}`;
      if (block.type === "bulletListItem") text = `- ${text}`;
      if (block.type === "numberedListItem") text = `1. ${text}`;
      if (block.type === "checkListItem") text = `- [${block.props?.checked ? "x" : " "}] ${text}`;
      if (block.type === "codeBlock") text = `\`\`\`\n${text}\n\`\`\``;
      lines.push(`${"  ".repeat(depth)}${text}`);
      if (block.children?.length) walk(block.children, depth + 1);
    }
  };
  walk(blocks, 0);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function textToBlocks(text) {
  return String(text).split("\n").map((line) => ({
    type: "paragraph",
    content: line ? [{ type: "text", text: line, styles: {} }] : [],
  }));
}

function findSpecDocId(text) {
  const match = String(text).match(/outline\.spaces\.community\/doc\/[a-z0-9-]*?-?([A-Za-z0-9]{10})(?=[)\s#?]|$)/);
  return match ? match[1] : null;
}

function sensitiveFiles(files) {
  return files.filter((file) => SENSITIVE_PATHS.some((re) => re.test(file)));
}

function parseAgentResult(text) {
  const value = String(text || "").trim();
  const first = value.split("\n", 1)[0].trim();
  if (/^RESULT:\s*DONE\b/i.test(first)) return { ok: true, summary: value.slice(first.length).trim() };
  const stuck = first.match(/^RESULT:\s*STUCK\b\s*[—:-]?\s*(.*)$/i);
  if (stuck) return { ok: false, reason: stuck[1] || "агент сообщил, что застрял", summary: value.slice(first.length).trim() };
  return { ok: false, reason: "агент не вернул строку RESULT", summary: value.slice(0, 3000) };
}

function buildPrompt({ task, branch, description, comments, spec, harness, rework }) {
  const parts = [
    "Ты — агент разработки проекта Spaces, запущенный автоматически из карточки Paca.",
    "Ниже опубликованные правила проекта (Harness), карточка, спецификация и комментарии владельца. Правила Harness обязательны.",
    "",
    "## Ограничения этого запуска",
    "- Работай только в текущей рабочей копии репозитория. Ветка: " + branch + ".",
    "- Доступа к сети, Outline, Paca, GitHub, серверу и секретам у тебя нет. Не пытайся их получить.",
    "- Разрешены: чтение/правка файлов, npm ci, npm run build, npm test и npm run test:*, npx playwright test, npx tsc, node --test, git status/diff/log/show/add/commit. Всё остальное будет отклонено.",
    "- Не пиши миграции, которые нужно применять к продакшен-базе, без явного требования спецификации; применять их ты всё равно не можешь.",
    "- Не меняй правила агентов (AGENTS.md, harness/) и инфраструктуру, если этого не требует спецификация.",
    "- Делай ровно то, что описано в спецификации. Если спецификации нет или она противоречива — не угадывай, заверши со статусом STUCK.",
    "- Перед завершением: npm run build и нужные тесты должны проходить; все изменения закоммичены с сообщением «SPC-" + task.task_number + ": …».",
    "- Пушит ветку, пишет комментарий в Paca и чекпойнт в Outline диспетчер, не ты.",
    "",
    "## Формат финального ответа (обязательно)",
    "Первая строка — ровно «RESULT: DONE» или «RESULT: STUCK — <причина>».",
    "Дальше по-русски, кратко: что изменено (файлы), какие проверки запускал и с каким итогом, что НЕ проверено, риски.",
    "",
    "## Harness проекта Spaces",
    "```json",
    JSON.stringify(harness, null, 2),
    "```",
    "",
    `## Карточка SPAC-${task.task_number}: ${task.title}`,
    description || "(описание пустое)",
    "",
    "## Спецификация из Outline",
    spec || "(спецификация не найдена — если задача не тривиальна, заверши со STUCK)",
  ];
  if (comments.length) {
    parts.push("", rework ? "## Комментарии (карточка возвращена на доработку — учти последние замечания владельца)" : "## Комментарии к карточке", ...comments);
  }
  return parts.join("\n");
}

// --- External APIs (dispatcher only) ------------------------------------------------

function createClients(fetchImpl = fetch) {
  async function paca(method, pathname, body) {
    const response = await fetchImpl(`${config.pacaUrl}/api/v1${pathname}`, {
      method,
      headers: { "X-API-Key": config.pacaApiKey, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) throw new Error(`Paca ${method} ${pathname} → ${response.status} ${data.error || ""}`);
    return data.data;
  }
  const project = `/projects/${config.pacaProjectId}`;
  return {
    getTask: (id) => paca("GET", `${project}/tasks/${id}`),
    setStatus: (id, statusId) => paca("PATCH", `${project}/tasks/${id}`, { status_id: statusId }),
    comment: (id, text) => paca("POST", `${project}/tasks/${id}/activities/comments`, { content: textToBlocks(text) }),
    async activities(id) {
      const data = await paca("GET", `${project}/tasks/${id}/activities`);
      return Array.isArray(data) ? data : data.items || [];
    },
    async approverIds() {
      const data = await paca("GET", "/admin/users?page_size=100");
      const users = Array.isArray(data) ? data : data.items || [];
      const userIds = users.filter((user) => config.approverEmails.includes(String(user.email || "").toLowerCase())).map((user) => user.id);
      // Activity actor_id is the project member id, not the user id.
      const membersData = await paca("GET", `${project}/members`);
      const members = Array.isArray(membersData) ? membersData : membersData.items || [];
      return members.filter((member) => userIds.includes(member.user_id)).map((member) => member.id);
    },
    async comments(id) {
      const data = await paca("GET", `${project}/tasks/${id}/activities`);
      const items = Array.isArray(data) ? data : data.items || [];
      return items.filter((item) => item.activity_type === "comment").slice(-30).map((item) => {
        const content = item.content?.content ?? item.content;
        return `- ${item.created_at} ${item.actor_name || item.actor_username || "?"}: ${blocksToText(content)}`;
      });
    },
    async harness() {
      const response = await fetchImpl(`${config.supabaseUrl}/rest/v1/rpc/get_agent_harness`, {
        method: "POST",
        headers: { apikey: config.supabaseAnonKey, Authorization: `Bearer ${config.supabaseAnonKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ p_project_id: config.spacesProjectId, p_secret: config.runnerSecret }),
      });
      if (!response.ok) throw new Error(`Harness RPC → ${response.status}`);
      return response.json();
    },
    async outline(method, body) {
      const response = await fetchImpl(`${config.outlineUrl}/api/${method}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.outlineApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`Outline ${method} → ${response.status}`);
      return data.data;
    },
  };
}

// --- Processes ------------------------------------------------------------------------

function run(cmd, args, { cwd, asAgent = false, extraEnv = {}, timeoutMs = 15 * 60 * 1000, input } = {}) {
  return new Promise((resolve) => {
    const baseEnv = asAgent
      ? {
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: config.agentHome, LANG: "C.UTF-8", CI: "1",
        GIT_AUTHOR_NAME: AGENT_NAME, GIT_AUTHOR_EMAIL: AGENT_EMAIL, GIT_COMMITTER_NAME: AGENT_NAME, GIT_COMMITTER_EMAIL: AGENT_EMAIL,
      }
      : { ...process.env };
    const child = spawn(cmd, args, {
      cwd,
      env: { ...baseEnv, ...extraEnv },
      ...(asAgent ? { uid: config.agentUid, gid: config.agentGid } : {}),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const cap = (s, chunk) => (s.length > 4_000_000 ? s : s + chunk);
    child.stdout.on("data", (c) => { stdout = cap(stdout, c.toString()); });
    child.stderr.on("data", (c) => { stderr = cap(stderr, c.toString()); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: signal ? 124 : code, stdout, stderr });
    });
    child.stdin.end(input || "");
  });
}

async function must(label, promise) {
  const result = await promise;
  if (result.code !== 0) throw new Error(`${label}: код ${result.code}\n${tail(result.stderr || result.stdout)}`);
  return result;
}

function tail(text, lines = 40) {
  return String(text || "").trim().split("\n").slice(-lines).join("\n");
}

const GIT_SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "safe.directory=*"];
const IDENTITY = ["-c", "user.name=Spaces agent runner", "-c", "user.email=agents@spaces.community"];

// --- Task processing ------------------------------------------------------------------

async function processTask(taskId, clients) {
  const task = await clients.getTask(taskId);
  if (task.project_id !== config.pacaProjectId) return log("skip foreign project", taskId);
  if (task.status_id === config.status.accepted) return processAcceptance(task, clients);
  const rework = task.status_id === config.status.rework;
  if (task.status_id !== config.status.backlog && !rework) return log("skip, status", task.status_id, taskId);

  const branch = `spc-${task.task_number}`;
  if (!BRANCH_PATTERN.test(branch)) throw new Error("bad branch name");
  const runId = `${branch}-${Date.now()}`;
  const runDir = path.join(config.workRoot, runId);
  const repoDir = path.join(runDir, "repo");
  log("start", runId);
  cleanupOldRuns();
  await clients.setStatus(taskId, config.status.inProgress);
  await clients.comment(taskId, `Агент взял задачу в работу (запуск ${runId}). Ветка: ${branch}.`);

  try {
    const description = blocksToText(task.description);
    const comments = await clients.comments(taskId);
    const harness = await clients.harness();
    let spec = "";
    const specId = findSpecDocId(description);
    if (specId) {
      try {
        spec = (await clients.outline("documents.info", { id: specId })).text || "";
      } catch (error) {
        log("spec fetch failed", error.message);
      }
    }

    fs.mkdirSync(runDir, { recursive: true, mode: 0o755 });
    fs.chownSync(runDir, config.agentUid, config.agentGid);
    const remoteBranch = await run("git", ["ls-remote", "--heads", config.repoUrl, branch], { asAgent: true, timeoutMs: 120000 });
    const startBranch = remoteBranch.stdout.trim() ? branch : "main";
    await must("clone", run("git", [...GIT_SAFE, "clone", "--depth", "100", "--branch", startBranch, config.repoUrl, repoDir], { asAgent: true, timeoutMs: 600000 }));
    await must("checkout", run("git", [...GIT_SAFE, "checkout", "-B", branch], { cwd: repoDir, asAgent: true }));
    const base = (await must("rev-parse", run("git", ["rev-parse", "HEAD"], { cwd: repoDir, asAgent: true }))).stdout.trim();
    await must("npm ci", run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: repoDir, asAgent: true, timeoutMs: 900000 }));

    const prompt = buildPrompt({ task, branch, description, comments, spec, harness, rework });
    const settingsPath = path.join(runDir, "claude-settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ALLOWED_TOOLS, deny: DISALLOWED_TOOLS } }), { mode: 0o644 });
    const agent = await run("claude", [
      "-p", "--output-format", "json",
      "--permission-mode", "dontAsk",
      "--permission-prompts", "none",
      "--allowedTools", ALLOWED_TOOLS.join(","),
      "--disallowedTools", DISALLOWED_TOOLS.join(","),
      "--settings", settingsPath,
      "--strict-mcp-config",
      "--max-turns", String(config.maxTurns),
    ], {
      cwd: repoDir,
      asAgent: true,
      input: prompt,
      extraEnv: { CLAUDE_CODE_OAUTH_TOKEN: config.claudeToken, DISABLE_AUTOUPDATER: "1" },
      timeoutMs: config.agentMinutes * 60 * 1000,
    });
    fs.writeFileSync(path.join(runDir, "agent-output.json"), agent.stdout);
    let resultText = "";
    try {
      resultText = JSON.parse(agent.stdout).result || "";
    } catch {
      resultText = agent.stdout;
    }
    const result = parseAgentResult(resultText);
    if (agent.code !== 0 && result.ok) Object.assign(result, { ok: false, reason: `claude завершился с кодом ${agent.code}` });
    if (!result.ok) throw Object.assign(new Error(result.reason), { summary: result.summary || tail(agent.stderr) });

    // Commit leftovers, then verify ourselves without any credentials in the environment.
    const dirty = await run("git", ["status", "--porcelain"], { cwd: repoDir, asAgent: true });
    if (dirty.stdout.trim()) {
      await must("add", run("git", [...GIT_SAFE, "add", "-A"], { cwd: repoDir, asAgent: true }));
      await must("commit", run("git", [...GIT_SAFE, ...IDENTITY, "commit", "-m", `SPC-${task.task_number}: незакоммиченные изменения агента`], { cwd: repoDir, asAgent: true }));
    }
    const count = Number((await run("git", ["rev-list", "--count", `${base}..HEAD`], { cwd: repoDir, asAgent: true })).stdout.trim() || 0);
    if (!count) throw Object.assign(new Error("агент не внёс изменений"), { summary: result.summary });
    await must("npm run build", run("npm", ["run", "build"], { cwd: repoDir, asAgent: true }));
    for (const script of ["test:harness", "test:billing", "test:mcp", "test:tasks", "test:security", "test:agents"]) {
      await must(`npm run ${script}`, run("npm", ["run", "--if-present", script], { cwd: repoDir, asAgent: true }));
    }
    const files = (await run("git", ["diff", "--name-only", `${base}..HEAD`], { cwd: repoDir, asAgent: true })).stdout.trim().split("\n").filter(Boolean);
    const patch = await must("format-patch", run("git", [...GIT_SAFE, "format-patch", "--binary", "--stdout", `${base}..HEAD`], { cwd: repoDir, asAgent: true }));

    // Push from a root-owned clean clone: no hooks/config from the agent's working copy.
    const pushDir = path.join(runDir, "push");
    await must("clean clone", run("git", ["clone", "--depth", "100", "--branch", startBranch, config.repoUrl, pushDir], { timeoutMs: 600000 }));
    await must("checkout", run("git", [...GIT_SAFE, "checkout", "-B", branch], { cwd: pushDir }));
    await must("am", run("git", [...GIT_SAFE, ...IDENTITY, "am", "--3way"], { cwd: pushDir, input: patch.stdout }));
    await must("push", run("git", [...GIT_SAFE, "push", config.pushUrl, `HEAD:refs/heads/${branch}`], {
      cwd: pushDir,
      timeoutMs: 300000,
      extraEnv: { GIT_SSH_COMMAND: `ssh -i ${config.deployKey} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${config.knownHosts}` },
    }));

    // Preview: stage := this task (it is rebuilt for every task, hence --force on this one branch only).
    const sha = (await must("rev-parse", run("git", ["rev-parse", "HEAD"], { cwd: pushDir }))).stdout.trim();
    await must("push stage", run("git", [...GIT_SAFE, "push", "--force", config.pushUrl, `HEAD:refs/heads/${STAGE_BRANCH}`], {
      cwd: pushDir,
      timeoutMs: 300000,
      extraEnv: { GIT_SSH_COMMAND: `ssh -i ${config.deployKey} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${config.knownHosts}` },
    }));
    const preview = await waitForPreview(sha);

    const flagged = sensitiveFiles(files);
    const compare = `${config.compareBase}${branch}`;
    const message = [
      `Готово к проверке владельцем. Ветка ${branch}, коммитов: ${count}.`,
      preview.ok
        ? `Превью (стейдж-база, миграции применены): ${config.previewUrl}`
        : `Превью НЕ обновилось: ${preview.error}`,
      `Сравнение изменений: ${compare}`,
      "Повторно проверено диспетчером: npm run build, unit-тесты (harness, billing, mcp, tasks, security). Playwright e2e диспетчер не запускает.",
      flagged.length ? `Внимание, изменены чувствительные файлы: ${flagged.join(", ")}` : "Чувствительные файлы (supabase/, infrastructure/, scripts/, package*.json, harness/, AGENTS.md) не менялись.",
      "Чтобы выкатить: проверьте превью и переведите карточку в «Принято» — раннер сольёт ветку в main, деплой применит миграции и выкатит, раннер проверит продакшен и переведёт в «Готово» (или откатит и переведёт в «Застрял»). Замечания — комментарием и статус «На доработку агенту».",
      "",
      "Отчёт агента:",
      result.summary.slice(0, 6000),
    ].join("\n");
    await clients.comment(taskId, message);
    await checkpoint(clients, specId, `агент-раннер ${runId}: ветка ${branch} готова к проверке`, message);
    await clients.setStatus(taskId, config.status.review);
    log("done", runId);
  } catch (error) {
    log("stuck", runId, error.message);
    const message = [`Застрял: ${error.message}`.slice(0, 4000), error.summary ? `\nОтчёт агента:\n${String(error.summary).slice(0, 4000)}` : ""].join("\n");
    await clients.comment(taskId, message).catch((e) => log("comment failed", e.message));
    await checkpoint(clients, findSpecDocId(blocksToText(task.description)), `агент-раннер ${runId}: застрял`, message).catch(() => {});
    await clients.setStatus(taskId, config.status.stuck).catch((e) => log("status failed", e.message));
  } finally {
    // Keep the last runs for inspection; drop node_modules to save disk.
    fs.rmSync(path.join(repoDir, "node_modules"), { recursive: true, force: true });
  }
}

// --- Acceptance (SPC-0020) --------------------------------------------------------------
// «Принято» by an approver → merge spc-<N> into main (checked again on the merged tree)
// → production deploy by scripts/deploy.sh on the host (migrations + backup live there)
// → production check → «Готово». On failure: revert main to the previous tree → «Застрял».

// actor of the latest status change, if that change was to `statusName`
function lastStatusChangeActor(activities, statusName) {
  const newestFirst = [...activities].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  for (const item of newestFirst) {
    if (item.activity_type !== "task.updated") continue;
    const change = (item.content?.changes || []).find((c) => c.field === "status");
    if (change) return change.new === statusName ? item.actor_id : null;
  }
  return null;
}

function readReleaseStatus(file = config.releaseStatusFile) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

async function waitForRelease(sha, { read = readReleaseStatus, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), minutes = config.releaseMinutes, intervalMs = 15000 } = {}) {
  const deadline = Date.now() + minutes * 60 * 1000;
  while (Date.now() < deadline) {
    const status = read();
    if (status && status.revision === sha) {
      return { ok: Boolean(status.ok), stage: status.stage || "", error: status.error || "", backup: status.backup || "", applied: Array.isArray(status.applied) ? status.applied : [] };
    }
    await sleep(intervalMs);
  }
  return { ok: false, stage: "timeout", error: `деплой не завершился за ${minutes} мин`, backup: "", applied: [] };
}

// What the owner needs to know about the database after a failed release.
function databaseNote(release) {
  if (!release || !release.backup) return "";
  if (release.applied && release.applied.length) {
    return `Миграции, применённые до сбоя: ${release.applied.join(", ")} — автооткат их не возвращает, нужно решение владельца. Резервная копия перед ними: ${release.backup}.`;
  }
  return `Миграции не применились, база не изменилась (резервная копия на всякий случай: ${release.backup}).`;
}

// Production answers and serves the bundle built from `sha` (vite defines the 12-char revision).
async function checkProduction(sha, { fetchImpl = fetch } = {}) {
  const short = sha.slice(0, 12);
  const base = config.productionUrl;
  try {
    for (const page of ["/", "/login"]) {
      const response = await fetchImpl(`${base}${page}?release=${Date.now()}`);
      if (!response.ok) return { ok: false, error: `${page} → HTTP ${response.status}` };
    }
    const html = await (await fetchImpl(`${base}/?release=${Date.now()}`)).text();
    const asset = html.match(/\/assets\/index-[^"']+\.js/);
    if (!asset) return { ok: false, error: "в index.html нет основного бандла" };
    const bundle = await fetchImpl(`${base}${asset[0]}`);
    if (!bundle.ok) return { ok: false, error: `${asset[0]} → HTTP ${bundle.status}` };
    if (!(await bundle.text()).includes(short)) return { ok: false, error: `продакшен отдаёт не ревизию ${short}` };
    return { ok: true, error: "" };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function waitForProduction(sha, { check = checkProduction, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 10, intervalMs = 30000 } = {}) {
  let last = { ok: false, error: "не проверялось" };
  for (let i = 0; i < attempts; i += 1) {
    last = await check(sha);
    if (last.ok) return last;
    await sleep(intervalMs);
  }
  return last;
}

async function processAcceptance(task, clients) {
  const taskId = task.id;
  const branch = `spc-${task.task_number}`;
  if (!BRANCH_PATTERN.test(branch)) throw new Error("bad branch name");
  const runId = `${branch}-${Date.now()}`;
  const runDir = path.join(config.workRoot, runId);
  log("accept", runId);

  const actor = lastStatusChangeActor(await clients.activities(taskId), "Принято");
  const approvers = await clients.approverIds();
  if (!actor || !approvers.includes(actor)) {
    await clients.setStatus(taskId, config.status.review);
    await clients.comment(taskId, "Принять задачу (слияние в main и выкатка в продакшен) может только владелец проекта. Статус возвращён в «На утверждение».");
    return log("accept denied", runId, actor);
  }

  const sshEnv = { GIT_SSH_COMMAND: `ssh -i ${config.deployKey} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${config.knownHosts}` };
  const pushDir = path.join(runDir, "main");
  const checkDir = path.join(runDir, "check");
  let previous = "";
  let merged = "";
  let pushed = false;
  try {
    await clients.comment(taskId, `Принято владельцем. Сливаю ${branch} в main и выкатываю (запуск ${runId}).`);
    fs.mkdirSync(runDir, { recursive: true, mode: 0o755 });
    await must("clone main", run("git", ["clone", "--branch", "main", config.repoUrl, pushDir], { timeoutMs: 600000 }));
    await must(`fetch ${branch}`, run("git", [...GIT_SAFE, "fetch", "origin", `refs/heads/${branch}`], { cwd: pushDir, timeoutMs: 300000 }));
    previous = (await must("rev-parse", run("git", ["rev-parse", "HEAD"], { cwd: pushDir }))).stdout.trim();
    const already = await run("git", ["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"], { cwd: pushDir });
    if (already.code === 0) throw new Error(`${branch} уже в main — сливать нечего`);
    const ff = await run("git", ["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"], { cwd: pushDir });
    const merge = ff.code === 0
      ? await run("git", [...GIT_SAFE, "merge", "--ff-only", "FETCH_HEAD"], { cwd: pushDir })
      : await run("git", [...GIT_SAFE, ...IDENTITY, "merge", "--no-ff", "--no-edit", "-m", `Merge ${branch} (SPAC-${task.task_number})`, "FETCH_HEAD"], { cwd: pushDir });
    if (merge.code !== 0) throw new Error(`конфликт слияния ${branch} с main — нужна доработка\n${tail(merge.stdout + merge.stderr, 15)}`);
    merged = (await must("rev-parse", run("git", ["rev-parse", "HEAD"], { cwd: pushDir }))).stdout.trim();
    const files = (await run("git", ["diff", "--name-only", `${previous}..${merged}`], { cwd: pushDir })).stdout.trim().split("\n").filter(Boolean);
    const migrations = files.filter((file) => /^supabase\/migrations\/.+\.sql$/.test(file));

    // Re-check the exact tree that goes to main, as the unprivileged user, without credentials.
    fs.mkdirSync(checkDir, { recursive: true, mode: 0o755 });
    await must("archive", run("sh", ["-c", `git -c safe.directory='*' archive ${merged} | tar -x -C ${checkDir}`], { cwd: pushDir }));
    await must("chown", run("chown", ["-R", `${config.agentUid}:${config.agentGid}`, checkDir]));
    await must("npm ci", run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: checkDir, asAgent: true, timeoutMs: 900000, extraEnv: { SPACES_GIT_REVISION: merged.slice(0, 12) } }));
    await must("npm run build", run("npm", ["run", "build"], { cwd: checkDir, asAgent: true, extraEnv: { SPACES_GIT_REVISION: merged.slice(0, 12) } }));
    for (const script of ["test:harness", "test:billing", "test:mcp", "test:tasks", "test:security", "test:agents"]) {
      await must(`npm run ${script}`, run("npm", ["run", "--if-present", script], { cwd: checkDir, asAgent: true }));
    }

    await must("push main", run("git", [...GIT_SAFE, "push", config.pushUrl, "HEAD:refs/heads/main"], { cwd: pushDir, timeoutMs: 300000, extraEnv: sshEnv }));
    pushed = true;
    const release = await waitForRelease(merged);
    if (!release.ok) throw Object.assign(new Error(`деплой не прошёл (этап ${release.stage}):\n${release.error}`), { release });
    const health = await waitForProduction(merged);
    if (!health.ok) throw Object.assign(new Error(`продакшен не прошёл проверку: ${health.error}`), { release });

    const message = [
      `Выкачено в продакшен: ${config.productionUrl} (main ${merged.slice(0, 12)}, было ${previous.slice(0, 12)}).`,
      migrations.length ? `Миграции применены: ${migrations.map((f) => path.basename(f)).join(", ")}. Резервная копия перед ними: ${release.backup || "—"}.` : "Миграций не было.",
      "Проверено: деплой завершён, / и /login отвечают, продакшен отдаёт бандл этой ревизии.",
    ].join("\n");
    await clients.comment(taskId, message);
    await checkpoint(clients, findSpecDocId(blocksToText(task.description)), `агент-раннер ${runId}: выкачено`, message);
    await clients.setStatus(taskId, config.status.done);
    log("released", runId);
    // The task branch is fully in main now; remove it (never main/stage: BRANCH_PATTERN checked above).
    const removed = await run("git", [...GIT_SAFE, "push", config.pushUrl, "--delete", `refs/heads/${branch}`], { cwd: pushDir, timeoutMs: 120000, extraEnv: sshEnv });
    if (removed.code !== 0) log("branch delete failed", branch, tail(removed.stderr, 3));
  } catch (error) {
    log("accept failed", runId, error.message);
    let rollback = "";
    if (pushed && previous) {
      rollback = await rollbackMain(pushDir, previous, task, sshEnv).catch((e) => `откат не удался: ${e.message}`);
    }
    const message = [
      `Застрял при выкатке: ${error.message}`.slice(0, 3000),
      pushed ? rollback : "main не менялся, продакшен не затронут.",
      databaseNote(error.release),
    ].filter(Boolean).join("\n");
    await clients.comment(taskId, message).catch((e) => log("comment failed", e.message));
    await checkpoint(clients, findSpecDocId(blocksToText(task.description)), `агент-раннер ${runId}: выкатка не удалась`, message).catch(() => {});
    await clients.setStatus(taskId, config.status.stuck).catch((e) => log("status failed", e.message));
  } finally {
    fs.rmSync(path.join(checkDir, "node_modules"), { recursive: true, force: true });
  }
}

// New commit on top of main whose tree is the previous release; never rewrites history.
async function rollbackMain(pushDir, previous, task, sshEnv) {
  await must("fetch main", run("git", [...GIT_SAFE, "fetch", "origin", "main"], { cwd: pushDir, timeoutMs: 300000 }));
  await must("reset", run("git", [...GIT_SAFE, "reset", "--hard", "FETCH_HEAD"], { cwd: pushDir }));
  const tree = (await must("tree", run("git", ["rev-parse", `${previous}^{tree}`], { cwd: pushDir }))).stdout.trim();
  const commit = (await must("commit-tree", run("git", [...GIT_SAFE, ...IDENTITY, "commit-tree", tree, "-p", "HEAD", "-m", `Revert SPAC-${task.task_number}: откат к ${previous.slice(0, 12)}`], { cwd: pushDir }))).stdout.trim();
  await must("push revert", run("git", [...GIT_SAFE, "push", config.pushUrl, `${commit}:refs/heads/main`], { cwd: pushDir, timeoutMs: 300000, extraEnv: sshEnv }));
  const release = await waitForRelease(commit);
  const health = release.ok ? await waitForProduction(commit) : { ok: false, error: release.error };
  return health.ok
    ? `Автооткат: main возвращён к состоянию ${previous.slice(0, 12)} (коммит ${commit.slice(0, 12)}), продакшен проверен.`
    : `Автооткат запушен (${commit.slice(0, 12)}), но продакшен после него не прошёл проверку: ${health.error}. Нужно вмешательство.`;
}

// Run directories are kept for inspection for 7 days.
function cleanupOldRuns(root = config.workRoot, maxAgeMs = 7 * 24 * 60 * 60 * 1000, now = Date.now()) {
  let removed = 0;
  for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    if (!/^spc-\d+-\d+$/.test(name)) continue;
    const dir = path.join(root, name);
    if (now - fs.statSync(dir).mtimeMs > maxAgeMs) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

// Waits until preview-deploy.sh on the host has published `sha` (or reported a failure for it).
async function waitForPreview(sha, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), minutes = config.previewMinutes, intervalMs = 20000 } = {}) {
  const deadline = Date.now() + minutes * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`${config.previewUrl}/preview-status.json?t=${Date.now()}`, { headers: { "Cache-Control": "no-cache" } });
      if (response.ok) {
        const status = await response.json();
        if (status.revision === sha) return { ok: Boolean(status.ok), error: status.ok ? "" : String(status.error || "ошибка превью").slice(0, 2000) };
      }
    } catch (error) {
      log("preview poll failed", error.message);
    }
    await sleep(intervalMs);
  }
  return { ok: false, error: `превью не обновилось за ${minutes} мин` };
}

async function checkpoint(clients, specId, title, body) {
  if (!specId) return;
  const date = new Date().toISOString().replace("T", " ").slice(0, 16);
  await clients.outline("documents.update", {
    id: specId,
    append: true,
    text: `\n\n### Checkpoint ${date} UTC — ${title}\n\n${body}\n`,
  }).catch((error) => log("checkpoint failed", error.message));
}

// --- Queue + HTTP ---------------------------------------------------------------------

function createQueue(clients, processor = processTask) {
  const queue = [];
  let running = null;
  async function pump() {
    if (running || !queue.length) return;
    running = queue.shift();
    try {
      await processor(running, clients);
    } catch (error) {
      log("task error", running, error.message);
    } finally {
      running = null;
      setImmediate(pump);
    }
  }
  return {
    add(taskId) {
      if (running === taskId || queue.includes(taskId)) return false;
      queue.push(taskId);
      setImmediate(pump);
      return true;
    },
    state: () => ({ running, queued: queue.length }),
  };
}

function createServer({ queue }) {
  return http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url, "http://runner.invalid");
    if (req.method === "GET" && url.pathname === "/spaces-agents/health") return send(200, { ok: true, ...queue.state() });
    if (req.method !== "POST" || url.pathname !== "/spaces-agents/hook") return send(404, { error: "Not found" });
    if (!safeEqual(req.headers["x-spaces-agent-secret"], config.hookSecret)) return send(401, { error: "Unauthorized" });
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 8192) return send(413, { error: "Too large" });
    }
    let taskId;
    try {
      taskId = JSON.parse(body || "{}").task_id;
    } catch {
      return send(400, { error: "Bad JSON" });
    }
    if (!uuidPattern.test(String(taskId || ""))) return send(400, { error: "task_id required" });
    return send(202, { accepted: queue.add(taskId) });
  });
}

if (require.main === module) {
  for (const key of ["hookSecret", "pacaApiKey", "supabaseUrl", "supabaseAnonKey", "runnerSecret", "outlineApiKey", "claudeToken"]) {
    if (!config[key]) throw new Error(`Missing config: ${key}`);
  }
  const clients = createClients();
  const queue = createQueue(clients);
  createServer({ queue }).listen(config.port, () => log(`agent runner on :${config.port}`));
}

module.exports = {
  blocksToText, textToBlocks, findSpecDocId, sensitiveFiles, parseAgentResult, buildPrompt, safeEqual,
  createClients, createQueue, createServer, waitForPreview, cleanupOldRuns,
  lastStatusChangeActor, waitForRelease, checkProduction, waitForProduction, databaseNote, ALLOWED_TOOLS, DISALLOWED_TOOLS, BRANCH_PATTERN, STAGE_BRANCH, config,
};
