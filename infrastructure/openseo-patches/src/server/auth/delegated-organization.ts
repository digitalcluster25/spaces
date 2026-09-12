import { AuthRepository } from "@/server/auth/repositories/AuthRepository";
import { slugify, toHex } from "./org-slug";

export type SpacesProjectContext = {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "member";
};

function getDelegatedOrganizationId(userId: string) {
  return `delegated-${userId}`;
}

function getDelegatedOrganizationName(email: string, userId: string) {
  return `${email.split("@")[0] || userId} workspace`;
}

function getDelegatedOrganizationSlug(email: string, userId: string) {
  const slugSource = email.split("@")[0] || userId;
  return `delegated-${slugify(slugSource)}-${toHex(userId)}`;
}

export async function ensureDelegatedOrganizationForUser(userId: string, email: string) {
  const organizationId = getDelegatedOrganizationId(userId);
  await AuthRepository.upsertDelegatedOrganization({
    id: organizationId,
    name: getDelegatedOrganizationName(email, userId),
    slug: getDelegatedOrganizationSlug(email, userId),
  });
  return organizationId;
}

export async function ensureDelegatedOrganizationForProject(
  userId: string,
  project: SpacesProjectContext,
) {
  const organizationId = `spaces-${project.id}`;
  await AuthRepository.upsertDelegatedOrganization({
    id: organizationId,
    name: project.name,
    slug: `spaces-${slugify(project.slug)}-${toHex(project.id).slice(0, 12)}`,
    metadata: JSON.stringify({ spacesProjectId: project.id }),
  });
  await AuthRepository.upsertDelegatedOrganizationMembership({
    organizationId,
    userId,
    role: project.role,
  });
  return organizationId;
}

export async function deleteDelegatedOrganizationForProject(projectId: string) {
  await AuthRepository.deleteDelegatedOrganization(`spaces-${projectId}`);
}
