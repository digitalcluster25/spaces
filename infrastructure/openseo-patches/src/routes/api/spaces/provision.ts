import { createFileRoute } from "@tanstack/react-router";
import { resolveDelegatedProjectContext } from "@/middleware/ensure-user/delegated";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { deleteDelegatedOrganizationForProject } from "@/server/auth/delegated-organization";

async function sameSecret(provided: string, expected: string) {
  const digest = async (value: string) => new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  const [left, right] = await Promise.all([digest(provided), digest(expected)]);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function handleProvision(request: Request) {
  const expected = await getOptionalEnvValue("SPACES_SERVICE_SECRET");
  const provided = String(request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!expected || !(await sameSecret(provided, expected))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const input = await request.json() as {
    operation?: string;
    project?: { id?: string; name?: string; slug?: string };
    owner?: { userId?: string; email?: string };
  };
  const project = input.project || {};
  const owner = input.owner || {};
  const projectId = String(project.id || "");
  const projectName = String(project.name || "");
  const projectSlug = String(project.slug || "");
  const ownerUserId = String(owner.userId || "");
  const ownerEmail = String(owner.email || "");
  if (
    !["provision", "resume", "restore", "suspend", "archive", "delete"].includes(String(input.operation)) ||
    !/^[0-9a-f-]{36}$/i.test(projectId) ||
    !projectName || !projectSlug || !ownerUserId || !ownerEmail
  ) {
    return Response.json({ error: "Invalid provisioning request" }, { status: 400 });
  }

  if (input.operation === "delete") {
    await deleteDelegatedOrganizationForProject(projectId);
    return Response.json({ externalTenantId: `spaces-${projectId}` });
  }
  if (["suspend", "archive"].includes(String(input.operation))) {
    return Response.json({ externalTenantId: `spaces-${projectId}` });
  }

  const context = await resolveDelegatedProjectContext(`spaces:${ownerUserId}`, ownerEmail, {
    id: projectId,
    name: projectName,
    slug: projectSlug,
    role: "owner",
  });
  return Response.json({ externalTenantId: context.organizationId });
}

export const Route = createFileRoute("/api/spaces/provision")({
  server: {
    handlers: {
      POST: ({ request }: { request: Request }) => handleProvision(request),
    },
  },
});
