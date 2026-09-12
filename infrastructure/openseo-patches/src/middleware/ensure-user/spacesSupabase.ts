import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { AppError } from "@/server/lib/errors";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { resolveDelegatedProjectContext } from "./delegated";
import type { EnsuredUserContext } from "./types";

const ACCESS_COOKIE = "spaces_access_token";
const PROJECT_COOKIE = "spaces_project_context";
const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

type SignedProjectContext = {
  projectId: string;
  projectName: string;
  projectSlug: string;
  userId: string;
  role: "owner" | "member";
  exp: number;
};

async function getSpacesSupabaseUrl() {
  const rawUrl = await getOptionalEnvValue("SPACES_SUPABASE_URL");
  if (!rawUrl) throw new AppError("AUTH_CONFIG_MISSING", "Missing SPACES_SUPABASE_URL for spaces_supabase auth mode.");
  return new URL(rawUrl).origin;
}

function getBearerToken(headers: Headers) {
  const authorization = headers.get("authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() || null : null;
}

function getCookie(headers: Headers, name: string) {
  const cookie = headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) return rawValue.join("=") || null;
  }
  return null;
}

function base64UrlToBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function verifyProjectContext(headers: Headers, spacesUserId: string) {
  const raw = headers.get("x-spaces-project-context") || getCookie(headers, PROJECT_COOKIE);
  const secret = await getOptionalEnvValue("SPACES_SERVICE_SECRET");
  const [payload, signature] = String(raw || "").split(".");
  if (!secret || !payload || !signature) throw new AppError("UNAUTHENTICATED");

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    base64UrlToBytes(signature),
    new TextEncoder().encode(payload),
  );
  if (!valid) throw new AppError("UNAUTHENTICATED");

  const context = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload))) as SignedProjectContext;
  if (
    context.userId !== spacesUserId ||
    context.exp < Date.now() ||
    !/^[0-9a-f-]{36}$/i.test(context.projectId) ||
    !context.projectName ||
    !context.projectSlug ||
    !["owner", "member"].includes(context.role)
  ) {
    throw new AppError("UNAUTHENTICATED");
  }
  return context;
}

async function authorizeProject(supabaseUrl: string, token: string, projectId: string) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/authorize_service_access`, {
    method: "POST",
    headers: {
      apikey: token,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ p_project_id: projectId, p_service_slug: "openseo" }),
  });
  if (!response.ok) throw new AppError("UNAUTHENTICATED");
  const project = await response.json() as {
    project_id?: string;
    project_name?: string;
    project_slug?: string;
    role?: "owner" | "member";
  } | null;
  if (!project?.project_id || !project.project_name || !project.project_slug || !project.role) {
    throw new AppError("UNAUTHENTICATED");
  }
  return {
    id: project.project_id,
    name: project.project_name,
    slug: project.project_slug,
    role: project.role,
  };
}

function getJwks(supabaseUrl: string) {
  const issuer = `${supabaseUrl}/auth/v1`;
  const existing = jwksByIssuer.get(issuer);
  if (existing) return existing;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  jwksByIssuer.set(issuer, jwks);
  return jwks;
}

function getEmail(payload: JWTPayload) {
  return typeof payload.email === "string" ? payload.email : null;
}

export async function resolveSpacesSupabaseContext(headers: Headers): Promise<EnsuredUserContext> {
  const token = getBearerToken(headers) ?? getCookie(headers, ACCESS_COOKIE);
  if (!token) throw new AppError("UNAUTHENTICATED");
  const supabaseUrl = await getSpacesSupabaseUrl();
  const issuer = `${supabaseUrl}/auth/v1`;
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, getJwks(supabaseUrl), { issuer, audience: "authenticated" }));
  } catch (error) {
    console.error("Spaces Supabase token verification failed:", error);
    throw new AppError("UNAUTHENTICATED");
  }
  const spacesUserId = typeof payload.sub === "string" ? payload.sub : null;
  const userEmail = getEmail(payload);
  if (!spacesUserId || !userEmail) throw new AppError("UNAUTHENTICATED");
  const signedProject = await verifyProjectContext(headers, spacesUserId);
  const project = await authorizeProject(supabaseUrl, token, signedProject.projectId);
  return resolveDelegatedProjectContext(`spaces:${spacesUserId}`, userEmail, {
    id: project.id,
    name: project.name,
    slug: project.slug,
    role: project.role,
  });
}

export async function resolveSpacesMcpContext(headers: Headers): Promise<EnsuredUserContext> {
  const token = getBearerToken(headers);
  if (!token?.startsWith("spc_")) return resolveSpacesSupabaseContext(headers);

  const supabaseUrl = await getSpacesSupabaseUrl();
  const anonKey = await getOptionalEnvValue("SUPABASE_ANON_KEY");
  const serviceSecret = await getOptionalEnvValue("SPACES_SERVICE_SECRET");
  if (!anonKey || !serviceSecret) throw new AppError("AUTH_CONFIG_MISSING", "Missing Spaces MCP configuration.");
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/exchange_mcp_credential`, {
    method: "POST",
    headers: { apikey: anonKey, "content-type": "application/json" },
    body: JSON.stringify({ p_token: token, p_service_slug: "openseo", p_service_secret: serviceSecret }),
  });
  if (!response.ok) throw new AppError("UNAUTHENTICATED");
  const context = await response.json() as {
    user_id?: string;
    email?: string;
    project_id?: string;
    project_name?: string;
    project_slug?: string;
    role?: "owner" | "member";
  };
  if (!context.user_id || !context.email || !context.project_id || !context.project_name || !context.project_slug || !context.role) {
    throw new AppError("UNAUTHENTICATED");
  }
  return resolveDelegatedProjectContext(`spaces:${context.user_id}`, context.email, {
    id: context.project_id,
    name: context.project_name,
    slug: context.project_slug,
    role: context.role,
  });
}
