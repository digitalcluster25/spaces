export const SUPERADMIN_EMAIL = "digitalcluster25@gmail.com";

const protectedPaths = new Set(["/account", "/invite", "/launch", "/superadmin", "/oauth/consent"]);

export function requiresSuperadminMfa(email: string | undefined, path: string, hostname: string) {
  return email?.toLowerCase() === SUPERADMIN_EMAIL
    && (hostname.startsWith("superadminko.") || protectedPaths.has(path));
}

// Spaces services registered by the owner as Supabase OAuth clients redirect to
// an https *.spaces.community URI; only those are approved without a consent screen.
export function isTrustedOAuthRedirect(redirectUri: string) {
  try {
    const url = new URL(redirectUri);
    return url.protocol === "https:" && url.hostname.endsWith(".spaces.community") && !url.username && !url.password;
  } catch {
    return false;
  }
}
