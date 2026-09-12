import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { member, organization, user as authUser } from "@/db/schema";

type DelegatedOrganizationInput = {
  id: string;
  name: string;
  slug: string;
  metadata?: string | null;
};

async function upsertDelegatedOrganization(input: DelegatedOrganizationInput) {
  await db
    .insert(organization)
    .values({
      id: input.id,
      name: input.name,
      slug: input.slug,
      logo: null,
      createdAt: new Date(),
      metadata: input.metadata ?? null,
    })
    .onConflictDoUpdate({
      target: organization.id,
      set: {
        name: input.name,
        slug: input.slug,
        metadata: input.metadata ?? null,
      },
    });
}

async function upsertDelegatedOrganizationMembership(input: {
  organizationId: string;
  userId: string;
  role: "owner" | "member";
}) {
  const existing = await db.query.member.findFirst({
    columns: { id: true, role: true },
    where: and(
      eq(member.organizationId, input.organizationId),
      eq(member.userId, input.userId),
    ),
  });
  if (existing) {
    if (existing.role !== input.role) {
      await db.update(member).set({ role: input.role }).where(eq(member.id, existing.id));
    }
    return;
  }
  await db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    userId: input.userId,
    role: input.role,
    createdAt: new Date(),
  });
}

async function deleteDelegatedOrganization(organizationId: string) {
  await db.delete(organization).where(eq(organization.id, organizationId));
}

async function findFirstOrganizationIdForUser(userId: string) {
  const [existingMembership] = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId))
    .orderBy(asc(member.createdAt))
    .limit(1);
  return existingMembership?.organizationId ?? null;
}

async function getHostedUser(userId: string) {
  return db.query.user.findFirst({
    columns: { id: true, email: true, name: true },
    where: eq(authUser.id, userId),
  });
}

export const AuthRepository = {
  upsertDelegatedOrganization,
  upsertDelegatedOrganizationMembership,
  deleteDelegatedOrganization,
  findFirstOrganizationIdForUser,
  getHostedUser,
} as const;
