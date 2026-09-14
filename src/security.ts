export const SUPERADMIN_EMAIL = "digitalcluster25@gmail.com";

const protectedPaths = new Set(["/account", "/invite", "/launch", "/superadmin"]);

export function requiresSuperadminMfa(email: string | undefined, path: string, hostname: string) {
  return email?.toLowerCase() === SUPERADMIN_EMAIL
    && (hostname.startsWith("superadminko.") || protectedPaths.has(path));
}
