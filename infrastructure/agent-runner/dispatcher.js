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
  // pwuser in the Playwright noble image is uid/gid 1001.
  agentUid: Number(env.AGENT_UID || 1001),
  agentGid: Number(env.AGENT_GID || 1001),
  agentHome: env.AGENT_HOME || "/home/pwuser",
  agentMinutes: Number(env.AGENT_MAX_MINUTES || 90),
  maxTurns: Number(env.AGENT_MAX_TURNS || 200),
  status: {
    review: env.STATUS_REVIEW || "0e199ff4-7e61-4c67-93ae-bc07de980968", // На утверждение
    rework: env.STATUS_REWORK || "f850de0e-9ebf-447a-8491-fee3a24afe10", // На доработку агенту
    backlog: env.STATUS_BACKLOG || "cf2a571c-4f81-489c-9a90-696460f77f85", // Беклог
    inProgress: env.STATUS_IN_PROGRESS || "7a14e900-6069-4814-906f-a83a00577b3e", // В процессе
    stuck: env.STATUS_STUCK || "e9a95f22-4d74-4c42-9f7a-71ea959764c2", // Застрял
  },
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
  const rework = task.status_id === config.status.rework;
  if (task.status_id !== config.status.backlog && !rework) return log("skip, status", task.status_id, taskId);

  const branch = `spc-${task.task_number}`;
  if (!BRANCH_PATTERN.test(branch)) throw new Error("bad branch name");
  const runId = `${branch}-${Date.now()}`;
  const runDir = path.join(config.workRoot, runId);
  const repoDir = path.join(runDir, "repo");
  log("start", runId);
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

    const flagged = sensitiveFiles(files);
    const compare = `${config.compareBase}${branch}`;
    const message = [
      `Готово к проверке владельцем. Ветка ${branch}, коммитов: ${count}.`,
      `Сравнение и создание PR: ${compare}`,
      "Повторно проверено диспетчером: npm run build, unit-тесты (harness, billing, mcp, tasks, security). Playwright e2e диспетчер не запускает.",
      flagged.length ? `Внимание, изменены чувствительные файлы: ${flagged.join(", ")}` : "Чувствительные файлы (supabase/, infrastructure/, scripts/, package*.json, harness/, AGENTS.md) не менялись.",
      "Слияние в main и проверку продакшена делает владелец, затем карточка → «Готово».",
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
  createClients, createQueue, createServer, ALLOWED_TOOLS, DISALLOWED_TOOLS, BRANCH_PATTERN, config,
};
