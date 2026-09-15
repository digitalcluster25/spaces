const crypto = require("crypto");

const requiredTitles = [
  "00 START HERE — протокол внешней памяти",
  "01 Текущее состояние платформы",
  "02 Очередь разработки",
  "03 Журнал решений ADR",
  "04 Релизы и проверки",
];
const outlineApiScopes = ["/api/documents.update"];

function clean(value, max) {
  const result = String(value || "").trim();
  if (result.length > max) throw Object.assign(new Error("Memory field is too long"), { status: 400 });
  return result;
}

function requirePattern(value, pattern, label) {
  if (!pattern.test(value)) throw Object.assign(new Error(`Invalid ${label}`), { status: 400 });
  return value;
}

function timestamp() {
  return new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function checkpointText(args) {
  const taskId = requirePattern(clean(args.taskId, 40), /^SPC-[0-9]{4,}$/, "task ID");
  const status = requirePattern(clean(args.status, 40), /^(STARTED|RESEARCHED|IMPLEMENTED|VERIFYING|DEPLOYED|BLOCKED)$/, "checkpoint status");
  const lines = [
    `### Checkpoint ${timestamp()} — ${taskId} — ${status}`,
    `Подтверждено: ${clean(args.confirmed, 4000)}`,
    `Изменено: ${clean(args.changed, 4000) || "нет"}`,
    `Проверки: ${clean(args.checks, 4000) || "не выполнялись"}`,
    `Риски: ${clean(args.risks, 2000) || "не выявлены"}`,
    `Следующий шаг: ${clean(args.nextStep, 2000)}`,
  ];
  if (!clean(args.confirmed, 4000) || !clean(args.nextStep, 2000)) throw Object.assign(new Error("Checkpoint is incomplete"), { status: 400 });
  return lines.join("\n\n");
}

function decisionText(args) {
  const id = requirePattern(clean(args.id, 40), /^ADR-[0-9]{4,}$/, "ADR ID");
  const status = requirePattern(clean(args.status, 40), /^(PROPOSED|ACCEPTED|REJECTED|SUPERSEDED)$/, "ADR status");
  const title = clean(args.title, 200);
  const context = clean(args.context, 5000);
  const decision = clean(args.decision, 5000);
  if (!title || !context || !decision) throw Object.assign(new Error("ADR is incomplete"), { status: 400 });
  return [
    `## ${id} — ${title}`,
    `Статус: ${status}`,
    `Дата: ${new Date().toISOString().slice(0, 10)}`,
    `Контекст: ${context}`,
    `Решение: ${decision}`,
    `Последствия: ${clean(args.consequences, 5000) || "не указаны"}`,
  ].join("\n\n");
}

function completionTexts(args) {
  const taskId = requirePattern(clean(args.taskId, 40), /^SPC-[0-9]{4,}$/, "task ID");
  const commit = requirePattern(clean(args.commit, 40), /^[0-9a-f]{7,40}$/, "commit");
  const revision = requirePattern(clean(args.productionRevision, 40), /^[0-9a-f]{7,40}$/, "production revision");
  const summary = clean(args.summary, 5000);
  const checks = clean(args.checks, 5000);
  const nextStep = clean(args.nextStep, 2000);
  if (!summary || !checks || !nextStep) throw Object.assign(new Error("Completion evidence is incomplete"), { status: 400 });
  return {
    queue: [
      `## DONE — ${taskId}`,
      `Статус: DONE`,
      `Результат: ${summary}`,
      `Проверки: ${checks}`,
      `Commit: ${commit}`,
      `Production revision: ${revision}`,
      `Следующий шаг: ${nextStep}`,
    ].join("\n\n"),
    release: [
      `## ${new Date().toISOString().slice(0, 10)} — ${taskId}`,
      `Результат: ${summary}`,
      `Проверки: ${checks}`,
      `Commit: ${commit}`,
      `Production revision: ${revision}`,
    ].join("\n\n"),
  };
}

function activeTaskSection(text, expectedTaskId = null) {
  const sections = String(text || "").match(/(?:^|\n)#{1,3}\s+[^\n]*SPC-\d{4,}[^\n]*[\s\S]*?(?=\n#{1,3}\s|$)/g) || [];
  const active = sections.filter((section) => /(?:^|\n)(?:\*\*)?Статус:(?:\*\*)?\s*ACTIVE\b/i.test(section));
  if (active.length !== 1) return null;
  if (expectedTaskId && !new RegExp(`\\b${expectedTaskId}\\b`).test(active[0])) return null;
  return active[0].trim();
}

function outlineProxyHeaders(publicOrigin) {
  const url = new URL(publicOrigin);
  return { host: url.host, "x-forwarded-proto": url.protocol.slice(0, -1) };
}

function createMemoryAdapter({ pool, outlineApiUrl = "http://outline:3000", publicOrigin = process.env.URL || "https://outline.spaces.community" }) {
  async function workspace(projectId) {
    const result = await pool.query(
      `select t.id as team_id, c.id as collection_id, c."urlId" as collection_url_id
       from teams t
       join collections c on c."teamId" = t.id and c."deletedAt" is null and c."archivedAt" is null
       where t."deletedAt" is null
         and t."suspendedAt" is null
         and t."signupQueryParams" ->> 'spaces_project_id' = $1
         and c.name = 'Разработка Spaces'
       limit 1`,
      [projectId],
    );
    if (!result.rowCount) throw Object.assign(new Error("Project memory is not configured"), { status: 404 });
    return result.rows[0];
  }

  async function documents(space) {
    const result = await pool.query(
      `select id, "urlId" as url_id, title, text, "updatedAt" as updated_at
       from documents
       where "teamId" = $1 and "collectionId" = $2 and "deletedAt" is null and "archivedAt" is null
       order by "updatedAt" desc`,
      [space.team_id, space.collection_id],
    );
    return result.rows;
  }

  async function findDocument(space, title) {
    const result = await pool.query(
      `select id, "urlId" as url_id, title, text, "updatedAt" as updated_at
       from documents
       where "teamId" = $1 and "collectionId" = $2 and title = $3
         and "deletedAt" is null and "archivedAt" is null
       limit 1`,
      [space.team_id, space.collection_id, title],
    );
    if (!result.rowCount) throw Object.assign(new Error(`Required memory document is missing: ${title}`), { status: 409 });
    return result.rows[0];
  }

  async function withApiKey(space, callback) {
    const user = await pool.query(
      `select id from users where "teamId" = $1 and "deletedAt" is null and role = 'admin' order by "createdAt" limit 1`,
      [space.team_id],
    );
    if (!user.rowCount) throw Object.assign(new Error("Project memory administrator is missing"), { status: 409 });
    const id = crypto.randomUUID();
    const token = `ol_api_${crypto.randomBytes(19).toString("hex")}`;
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    await pool.query(
      `insert into "apiKeys" (id, name, hash, "last4", scope, "userId", "createdAt", "updatedAt", "expiresAt")
       values ($1, 'Spaces Memory Adapter', $2, $3, $4, $5, now(), now(), now() + interval '2 minutes')`,
      [id, hash, token.slice(-4), outlineApiScopes, user.rows[0].id],
    );
    try {
      return await callback(token);
    } finally {
      await pool.query('update "apiKeys" set "deletedAt" = now(), "updatedAt" = now() where id = $1', [id]).catch(() => {});
    }
  }

  async function updateDocument(space, documentId, body) {
    return withApiKey(space, async (token) => {
      const response = await fetch(`${outlineApiUrl}/api/documents.update`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
          ...outlineProxyHeaders(publicOrigin),
        },
        body: JSON.stringify({ id: documentId, ...body, done: true }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw Object.assign(new Error(result?.message || `Outline update failed (${response.status})`), { status: response.status });
      return result?.data;
    });
  }

  return async function handleMemory(input) {
    if (!/^[0-9a-f-]{36}$/i.test(String(input.projectId || ""))) throw Object.assign(new Error("Invalid project"), { status: 400 });
    const space = await workspace(input.projectId);
    const operation = String(input.operation || "");
    const args = input.args || {};

    if (operation === "bootstrap") {
      const rows = await documents(space);
      const byTitle = new Map(rows.map((row) => [row.title, row]));
      const missing = requiredTitles.filter((title) => !byTitle.has(title));
      if (missing.length) throw Object.assign(new Error(`Memory bootstrap is incomplete: ${missing.join(", ")}`), { status: 409 });
      return {
        projectId: input.projectId,
        collection: { id: space.collection_id, urlId: space.collection_url_id },
        documents: requiredTitles.map((title) => byTitle.get(title)),
      };
    }
    if (operation === "get_active_task") {
      const queue = await findDocument(space, "02 Очередь разработки");
      return { document: queue, activeTask: activeTaskSection(queue.text) };
    }
    if (operation === "search") {
      const query = clean(args.query, 300);
      if (query.length < 2) throw Object.assign(new Error("Search query is too short"), { status: 400 });
      const result = await pool.query(
        `select id, "urlId" as url_id, title,
                left(regexp_replace(coalesce(text, ''), E'\\s+', ' ', 'g'), 1200) as excerpt,
                "updatedAt" as updated_at
         from documents
         where "teamId" = $1 and "collectionId" = $2 and "deletedAt" is null and "archivedAt" is null
           and (title ilike '%' || $3 || '%' or coalesce(text, '') ilike '%' || $3 || '%')
         order by "updatedAt" desc limit 20`,
        [space.team_id, space.collection_id, query],
      );
      return { query, results: result.rows };
    }
    if (operation === "append_checkpoint") {
      const queue = await findDocument(space, "02 Очередь разработки");
      const text = checkpointText(args);
      if (!activeTaskSection(queue.text, args.taskId)) throw Object.assign(new Error("Task is not ACTIVE"), { status: 409 });
      await updateDocument(space, queue.id, { text: `\n\n${text}`, editMode: "append" });
      return { appended: true, documentId: queue.id, taskId: args.taskId };
    }
    if (operation === "record_decision") {
      const adr = await findDocument(space, "03 Журнал решений ADR");
      if (adr.text?.includes(args.id)) throw Object.assign(new Error("ADR already exists"), { status: 409 });
      await updateDocument(space, adr.id, { text: `\n\n${decisionText(args)}`, editMode: "append" });
      return { recorded: true, documentId: adr.id, decisionId: args.id };
    }
    if (operation === "complete_task") {
      const queue = await findDocument(space, "02 Очередь разработки");
      const releases = await findDocument(space, "04 Релизы и проверки");
      const text = completionTexts(args);
      if (!activeTaskSection(queue.text, args.taskId)) throw Object.assign(new Error("Task is not ACTIVE"), { status: 409 });
      await updateDocument(space, queue.id, { findText: "Статус: ACTIVE", text: "Статус: DONE", editMode: "patch" });
      await updateDocument(space, queue.id, { text: `\n\n${text.queue}`, editMode: "append" });
      await updateDocument(space, releases.id, { text: `\n\n${text.release}`, editMode: "append" });
      return { completed: true, taskId: args.taskId, queueDocumentId: queue.id, releaseDocumentId: releases.id };
    }
    throw Object.assign(new Error("Unknown memory operation"), { status: 404 });
  };
}

module.exports = { activeTaskSection, checkpointText, completionTexts, createMemoryAdapter, decisionText, outlineApiScopes, outlineProxyHeaders, requiredTitles };
