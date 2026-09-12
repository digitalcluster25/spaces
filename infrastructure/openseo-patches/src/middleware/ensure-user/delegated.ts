import { db } from "@/db";
import { user } from "@/db/schema";
import {
  ensureDelegatedOrganizationForProject,
  ensureDelegatedOrganizationForUser,
  type SpacesProjectContext,
} from "@/server/auth/delegated-organization";
import { eq } from "drizzle-orm";
import type { EnsuredUserContext } from "./types";

const LOCAL_ADMIN_USER_ID = "local-admin";
const LOCAL_ADMIN_EMAIL = "admin@localhost";

function deriveUserName(email: string) {
  return email.split("@")[0] || "OpenSEO";
}

async function ensureUserRecord(userId: string, userEmail: string) {
  const existing = await db.query.user.findFirst({
    columns: { email: true },
    where: eq(user.id, userId),
  });
  if (!existing) {
    await db
      .insert(user)
      .values({
        id: userId,
        name: deriveUserName(userEmail),
        email: userEmail,
        emailVerified: true,
      })
      .onConflictDoNothing({ target: user.id });
    return userEmail;
  }
  if (existing.email !== userEmail) {
    await db
      .update(user)
      .set({ email: userEmail, name: deriveUserName(userEmail) })
      .where(eq(user.id, userId));
  }
  return userEmail;
}

export async function resolveDelegatedContext(
  userId: string,
  userEmail: string,
): Promise<EnsuredUserContext> {
  const ensuredEmail = await ensureUserRecord(userId, userEmail);
  const organizationId = await ensureDelegatedOrganizationForUser(userId, ensuredEmail);
  return { userId, userEmail: ensuredEmail, emailVerified: true, organizationId };
}

export async function resolveDelegatedProjectContext(
  userId: string,
  userEmail: string,
  project: SpacesProjectContext,
): Promise<EnsuredUserContext> {
  const ensuredEmail = await ensureUserRecord(userId, userEmail);
  const organizationId = await ensureDelegatedOrganizationForProject(userId, project);
  return { userId, userEmail: ensuredEmail, emailVerified: true, organizationId };
}

export async function resolveLocalNoAuthContext(): Promise<EnsuredUserContext> {
  return resolveDelegatedContext(LOCAL_ADMIN_USER_ID, LOCAL_ADMIN_EMAIL);
}
