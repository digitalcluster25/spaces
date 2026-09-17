import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const protocolVersion = "2025-06-18";
const required = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "MCP_GATEWAY_SECRET", "OUTLINE_ADAPTER_SECRET"];
const readScopes = new Set(["memory:read", "memory:write"]);
const writeScope = "memory:write";

function json(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  response.end(body === null ? "" : JSON.stringify(body));
}

async function readJson(request, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}

function bearer(request) {
  return request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] || null;
}

function rpcError(id, code, message, data) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function textResult(value, isError = false) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function hasScope(context, scope) {
  return Array.isArray(context.scopes) && context.scopes.includes(scope);
}

function memoryReadable(context) {
  return context.scopes?.some((scope) => readScopes.has(scope));
}

function knowledgeReadable(context) {
  return hasScope(context, "knowledge:read") || hasScope(context, "knowledge:write");
}

function publicTools(context) {
  const tools = [];
  if (memoryReadable(context)) {
    tools.push(
      {
        name: "memory.bootstrap",
        description: "Load the Spaces project START HERE, current state, active task, latest checkpoint, and ADR log.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "memory.search",
        description: "Search only the Outline development collection bound to this project.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string", minLength: 2, maxLength: 300 } },
          required: ["query"],
          additionalProperties: false,
        },
      },
      {
        name: "memory.get_active_task",
        description: "Return the task queue and the currently ACTIVE SPC task for this project.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    );
  }
  if (hasScope(context, writeScope)) {
    tools.push(
      {
        name: "memory.activate_task",
        description: "Activate one SPC task when the project queue has no other ACTIVE task.",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string", pattern: "^SPC-[0-9]{4,}$" },
            title: { type: "string", minLength: 3, maxLength: 200 },
            goal: { type: "string", minLength: 1, maxLength: 5000 },
            requirements: { type: "string", minLength: 1, maxLength: 8000 },
            acceptance: { type: "string", minLength: 1, maxLength: 8000 },
            rollback: { type: "string", minLength: 1, maxLength: 4000 },
            firstCheckpoint: { type: "string", minLength: 1, maxLength: 4000 },
          },
          required: ["taskId", "title", "goal", "requirements", "acceptance", "rollback", "firstCheckpoint"],
          additionalProperties: false,
        },
      },
      {
        name: "memory.append_checkpoint",
        description: "Append a structured checkpoint to the active Spaces task.",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string", pattern: "^SPC-[0-9]{4,}$" },
            status: { type: "string", enum: ["STARTED", "RESEARCHED", "IMPLEMENTED", "VERIFYING", "DEPLOYED", "BLOCKED"] },
            confirmed: { type: "string", minLength: 1, maxLength: 4000 },
            changed: { type: "string", maxLength: 4000 },
            checks: { type: "string", maxLength: 4000 },
            risks: { type: "string", maxLength: 2000 },
            nextStep: { type: "string", minLength: 1, maxLength: 2000 },
          },
          required: ["taskId", "status", "confirmed", "nextStep"],
          additionalProperties: false,
        },
      },
      {
        name: "memory.record_decision",
        description: "Append an accepted or proposed ADR to the project decision log.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", pattern: "^ADR-[0-9]{4,}$" },
            title: { type: "string", minLength: 3, maxLength: 200 },
            status: { type: "string", enum: ["PROPOSED", "ACCEPTED", "REJECTED", "SUPERSEDED"] },
            context: { type: "string", minLength: 1, maxLength: 5000 },
            decision: { type: "string", minLength: 1, maxLength: 5000 },
            consequences: { type: "string", maxLength: 5000 },
          },
          required: ["id", "title", "status", "context", "decision"],
          additionalProperties: false,
        },
      },
      {
        name: "memory.complete_task",
        description: "Record verified task completion in the queue and release evidence log.",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string", pattern: "^SPC-[0-9]{4,}$" },
            summary: { type: "string", minLength: 1, maxLength: 5000 },
            checks: { type: "string", minLength: 1, maxLength: 5000 },
            commit: { type: "string", pattern: "^[0-9a-f]{7,40}$" },
            productionRevision: { type: "string", pattern: "^[0-9a-f]{7,40}$" },
            nextStep: { type: "string", minLength: 1, maxLength: 2000 },
          },
          required: ["taskId", "summary", "checks", "commit", "productionRevision", "nextStep"],
          additionalProperties: false,
        },
      },
    );
  }
  if (knowledgeReadable(context)) {
    tools.push({
      name: "knowledge.search",
      description: "Search project-scoped knowledge using text and, optionally, a 1536-dimensional embedding.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", maxLength: 1000 },
          embedding: { type: "array", items: { type: "number" }, minItems: 1536, maxItems: 1536 },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      },
    });
  }
  if (hasScope(context, "knowledge:write")) {
    tools.push({
      name: "knowledge.upsert",
      description: "Create or update one project-scoped knowledge document. The project is fixed by the MCP credential.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          title: { type: "string", minLength: 1, maxLength: 240 },
          content: { type: "string", minLength: 1, maxLength: 200000 },
          sourceType: { type: "string", enum: ["manual", "file", "service", "agent", "outline"] },
          sourceId: { type: "string", maxLength: 500 },
          service: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,79}$" },
          metadata: { type: "object" },
          embedding: { type: "array", items: { type: "number" }, minItems: 1536, maxItems: 1536 },
          embeddingModel: { type: "string", maxLength: 120 },
        },
        required: ["title", "content"],
        additionalProperties: false,
      },
    });
  }
  if (hasScope(context, "openseo:*")) {
    tools.push({
      name: "openseo.tools",
      description: "List the OpenSEO tools available to this project through its isolated service tenant.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    });
    tools.push({
      name: "openseo.call",
      description: "Call one OpenSEO MCP tool in this project tenant.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 200 },
          arguments: { type: "object" },
        },
        required: ["name"],
        additionalProperties: false,
      },
    });
  }
  return tools;
}

function assertInput(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { code: -32602, status: 400 });
}

function stringField(args, name, { required: needed = false, max = 5000, pattern, values } = {}) {
  const value = args?.[name];
  if (value === undefined && !needed) return "";
  assertInput(typeof value === "string" && (!needed || value.trim()), `${name} is required`);
  assertInput(value.length <= max, `${name} is too long`);
  if (pattern) assertInput(pattern.test(value), `${name} has invalid format`);
  if (values) assertInput(values.includes(value), `${name} is unsupported`);
  return value.trim();
}

function vectorField(args, name) {
  const value = args?.[name];
  if (value === undefined || value === null) return null;
  assertInput(Array.isArray(value) && value.length === 1536, `${name} must contain 1536 numbers`);
  assertInput(value.every((item) => typeof item === "number" && Number.isFinite(item)), `${name} contains an invalid number`);
  return `[${value.join(",")}]`;
}

function validateMemoryInput(operation, input) {
  const args = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  if (operation === "bootstrap" || operation === "get_active_task") return {};
  if (operation === "search") {
    return { query: stringField(args, "query", { required: true, max: 300 }) };
  }
  if (operation === "append_checkpoint") {
    return {
      taskId: stringField(args, "taskId", { required: true, pattern: /^SPC-[0-9]{4,}$/ }),
      status: stringField(args, "status", { required: true, values: ["STARTED", "RESEARCHED", "IMPLEMENTED", "VERIFYING", "DEPLOYED", "BLOCKED"] }),
      confirmed: stringField(args, "confirmed", { required: true, max: 4000 }),
      changed: stringField(args, "changed", { max: 4000 }),
      checks: stringField(args, "checks", { max: 4000 }),
      risks: stringField(args, "risks", { max: 2000 }),
      nextStep: stringField(args, "nextStep", { required: true, max: 2000 }),
    };
  }
  if (operation === "activate_task") {
    return {
      taskId: stringField(args, "taskId", { required: true, pattern: /^SPC-[0-9]{4,}$/ }),
      title: stringField(args, "title", { required: true, max: 200 }),
      goal: stringField(args, "goal", { required: true, max: 5000 }),
      requirements: stringField(args, "requirements", { required: true, max: 8000 }),
      acceptance: stringField(args, "acceptance", { required: true, max: 8000 }),
      rollback: stringField(args, "rollback", { required: true, max: 4000 }),
      firstCheckpoint: stringField(args, "firstCheckpoint", { required: true, max: 4000 }),
    };
  }
  if (operation === "record_decision") {
    return {
      id: stringField(args, "id", { required: true, pattern: /^ADR-[0-9]{4,}$/ }),
      title: stringField(args, "title", { required: true, max: 200 }),
      status: stringField(args, "status", { required: true, values: ["PROPOSED", "ACCEPTED", "REJECTED", "SUPERSEDED"] }),
      context: stringField(args, "context", { required: true }),
      decision: stringField(args, "decision", { required: true }),
      consequences: stringField(args, "consequences"),
    };
  }
  if (operation === "complete_task") {
    return {
      taskId: stringField(args, "taskId", { required: true, pattern: /^SPC-[0-9]{4,}$/ }),
      summary: stringField(args, "summary", { required: true }),
      checks: stringField(args, "checks", { required: true }),
      commit: stringField(args, "commit", { required: true, pattern: /^[0-9a-f]{7,40}$/ }),
      productionRevision: stringField(args, "productionRevision", { required: true, pattern: /^[0-9a-f]{7,40}$/ }),
      nextStep: stringField(args, "nextStep", { required: true, max: 2000 }),
    };
  }
  throw Object.assign(new Error("Unknown memory operation"), { code: -32601, status: 404 });
}

export function createGateway({ fetchImpl = fetch, now = () => Date.now(), rateLimit = Number(process.env.MCP_RATE_LIMIT || 60) } = {}) {
  const buckets = new Map();

  async function post(url, headers, body) {
    const response = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body) });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(data?.message || data?.error || `Upstream failed (${response.status})`), { status: response.status });
    return data;
  }

  async function authorize(token) {
    let context;
    try {
      context = await post(
        `${process.env.SUPABASE_URL}/rest/v1/rpc/exchange_mcp_gateway_credential`,
        { apikey: process.env.SUPABASE_ANON_KEY, "content-type": "application/json" },
        { p_token: token, p_gateway_secret: process.env.MCP_GATEWAY_SECRET },
      );
    } catch (error) {
      throw Object.assign(new Error(error.status >= 500 ? "Authentication service unavailable" : "Invalid or expired MCP credential"), {
        status: error.status >= 500 ? 503 : 401,
      });
    }
    if (!context?.credential_id || !context?.project_id || !Array.isArray(context.scopes)) {
      throw Object.assign(new Error("Invalid credential context"), { status: 401 });
    }
    return context;
  }

  function enforceRateLimit(context) {
    const minute = Math.floor(now() / 60_000);
    const key = `${context.credential_id}:${minute}`;
    const count = (buckets.get(key) || 0) + 1;
    buckets.set(key, count);
    if (buckets.size > 1000) {
      for (const bucket of buckets.keys()) if (!bucket.endsWith(`:${minute}`)) buckets.delete(bucket);
    }
    if (count > rateLimit) throw Object.assign(new Error("Rate limit exceeded"), { status: 429, code: -32029 });
  }

  async function enforceDistributedRateLimit(context, request) {
    if (process.env.MCP_DISTRIBUTED_RATE_LIMIT !== "true") return enforceRateLimit(context);
    const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const result = await post(
      `${process.env.SUPABASE_URL}/rest/v1/rpc/consume_mcp_rate_limit`,
      { apikey: process.env.SUPABASE_ANON_KEY, "content-type": "application/json" },
      { p_credential_id: context.credential_id, p_ip: forwarded, p_gateway_secret: process.env.MCP_GATEWAY_SECRET },
    );
    if (!result?.allowed) throw Object.assign(new Error("Rate limit exceeded"), { status: 429, code: -32029, retryAfter: result?.retry_after || 1 });
  }

  async function audit(context, tool, success, startedAt, errorCode = null) {
    await post(
      `${process.env.SUPABASE_URL}/rest/v1/rpc/record_mcp_gateway_call`,
      { apikey: process.env.SUPABASE_ANON_KEY, "content-type": "application/json" },
      {
        p_credential_id: context.credential_id,
        p_tool: tool,
        p_success: success,
        p_duration_ms: Math.max(0, now() - startedAt),
        p_error_code: errorCode,
        p_gateway_secret: process.env.MCP_GATEWAY_SECRET,
      },
    ).catch(() => {});
  }

  async function outline(context, operation, args) {
    return post(
      process.env.OUTLINE_ADAPTER_URL || "http://outline-spaces-sso:3000/spaces-internal/memory",
      { authorization: `Bearer ${process.env.OUTLINE_ADAPTER_SECRET}`, "content-type": "application/json" },
      { projectId: context.project_id, operation, args },
    );
  }

  async function openSeo(token, method, params = {}) {
    return post(
      process.env.OPENSEO_MCP_URL || "http://openseo.spaces.community:3001/mcp",
      {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": protocolVersion,
        "x-forwarded-proto": "https",
      },
      { jsonrpc: "2.0", id: 1, method, params },
    );
  }

  async function knowledgeRpc(name, body) {
    return post(
      `${process.env.SUPABASE_URL}/rest/v1/rpc/${name}`,
      { apikey: process.env.SUPABASE_ANON_KEY, "content-type": "application/json" },
      body,
    );
  }

  async function callTool(context, token, name, args) {
    if (name.startsWith("memory.")) {
      if (!memoryReadable(context)) throw Object.assign(new Error("memory:read scope required"), { status: 403, code: -32003 });
      if (["memory.activate_task", "memory.append_checkpoint", "memory.record_decision", "memory.complete_task"].includes(name) && !hasScope(context, writeScope)) {
        throw Object.assign(new Error("memory:write scope required"), { status: 403, code: -32003 });
      }
      const operation = name.slice("memory.".length);
      return outline(context, operation, validateMemoryInput(operation, args));
    }
    if (name === "knowledge.search") {
      if (!knowledgeReadable(context)) throw Object.assign(new Error("knowledge:read scope required"), { status: 403, code: -32003 });
      const query = stringField(args, "query", { max: 1000 });
      const embedding = vectorField(args, "embedding");
      assertInput(Boolean(query || embedding), "query or embedding is required");
      const limit = args?.limit === undefined ? 10 : Number(args.limit);
      assertInput(Number.isInteger(limit) && limit >= 1 && limit <= 50, "limit must be from 1 to 50");
      return knowledgeRpc("mcp_search_project_knowledge", {
        p_credential_id: context.credential_id,
        p_query: query,
        p_embedding: embedding,
        p_limit: limit,
        p_gateway_secret: process.env.MCP_GATEWAY_SECRET,
      });
    }
    if (name === "knowledge.upsert") {
      if (!hasScope(context, "knowledge:write")) throw Object.assign(new Error("knowledge:write scope required"), { status: 403, code: -32003 });
      const id = stringField(args, "id", { pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i });
      const title = stringField(args, "title", { required: true, max: 240 });
      const content = stringField(args, "content", { required: true, max: 200000 });
      const sourceType = stringField(args, "sourceType", { values: ["manual", "file", "service", "agent", "outline"] }) || "agent";
      const sourceId = stringField(args, "sourceId", { max: 500 });
      const service = stringField(args, "service", { pattern: /^[a-z0-9][a-z0-9-]{0,79}$/ }) || "spaces";
      const embeddingModel = stringField(args, "embeddingModel", { max: 120 });
      const metadata = args?.metadata ?? {};
      assertInput(metadata && typeof metadata === "object" && !Array.isArray(metadata), "metadata must be an object");
      return knowledgeRpc("mcp_upsert_project_knowledge", {
        p_credential_id: context.credential_id,
        p_document_id: id || null,
        p_title: title,
        p_content: content,
        p_source_type: sourceType,
        p_source_id: sourceId || null,
        p_service_slug: service,
        p_metadata: metadata,
        p_embedding: vectorField(args, "embedding"),
        p_embedding_model: embeddingModel || null,
        p_gateway_secret: process.env.MCP_GATEWAY_SECRET,
      });
    }
    if (name === "openseo.tools") {
      if (!hasScope(context, "openseo:*")) throw Object.assign(new Error("openseo:* scope required"), { status: 403, code: -32003 });
      const result = await openSeo(token, "tools/list", {});
      return result.result ?? result;
    }
    if (name === "openseo.call") {
      if (!hasScope(context, "openseo:*")) throw Object.assign(new Error("openseo:* scope required"), { status: 403, code: -32003 });
      const toolName = stringField(args, "name", { required: true, max: 200 });
      assertInput(!toolName.startsWith("memory."), "Invalid OpenSEO tool name");
      const result = await openSeo(token, "tools/call", { name: toolName, arguments: args?.arguments || {} });
      return result.result ?? result;
    }
    throw Object.assign(new Error("Unknown tool"), { status: 404, code: -32601 });
  }

  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") return json(response, 200, { status: "ok" });
    if (request.method !== "POST" || request.url !== "/mcp") return json(response, 404, { error: "Not found" });

    const token = bearer(request);
    if (!token?.startsWith("spc_")) return json(response, 401, rpcError(null, -32001, "Authentication required"), { "www-authenticate": "Bearer" });
    let message;
    try {
      message = await readJson(request);
      assertInput(message?.jsonrpc === "2.0" && typeof message?.method === "string", "Invalid JSON-RPC request");
      const context = await authorize(token);
      await enforceDistributedRateLimit(context, request);

      if (message.method === "initialize") {
        return json(response, 200, rpcResult(message.id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "Spaces MCP Gateway", version: "0.1.0" },
          instructions: `Project context is fixed by the credential: ${context.project_name}. Never send or trust a project_id argument.`,
        }), { "mcp-protocol-version": protocolVersion });
      }
      if (message.method === "notifications/initialized") return json(response, 202, null);
      if (message.method === "ping") return json(response, 200, rpcResult(message.id, {}));
      if (message.method === "tools/list") return json(response, 200, rpcResult(message.id, { tools: publicTools(context) }), { "mcp-protocol-version": protocolVersion });
      if (message.method !== "tools/call") return json(response, 200, rpcError(message.id, -32601, "Method not found"));

      const name = message.params?.name;
      assertInput(typeof name === "string", "Tool name is required");
      const startedAt = now();
      try {
        const result = await callTool(context, token, name, message.params?.arguments || {});
        await audit(context, name, true, startedAt);
        return json(response, 200, rpcResult(message.id, result?.content ? result : textResult(result)));
      } catch (error) {
        await audit(context, name, false, startedAt, String(error.code || error.status || "tool_error"));
        return json(response, 200, rpcResult(message.id, textResult(error.status && error.status < 500 ? error.message : "Tool temporarily unavailable", true)));
      }
    } catch (error) {
      const status = Number(error.status) || 500;
      const code = Number(error.code) || (status === 401 ? -32001 : status === 429 ? -32029 : -32603);
      return json(response, status, rpcError(message?.id, code, status < 500 ? error.message : "Gateway unavailable"), status === 401 ? { "www-authenticate": "Bearer" } : {});
    }
  });
}

export function hashTokenForLogs(token) {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

export function equalSecret(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing required environment: ${missing.join(", ")}`);
  createGateway().listen(3000, "0.0.0.0", () => console.log("Spaces MCP Gateway listening on 3000"));
}
