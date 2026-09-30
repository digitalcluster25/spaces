import assert from "node:assert/strict";
import test from "node:test";
import { isTrustedOAuthRedirect, requiresSuperadminMfa } from "./security.ts";

const owner = "digitalcluster25@gmail.com";

test("keeps public Spaces pages available to the signed-in superadmin", () => {
  assert.equal(requiresSuperadminMfa(owner, "/", "spaces.community"), false);
  assert.equal(requiresSuperadminMfa(owner, "/privacy", "spaces.community"), false);
});

test("requires MFA for superadmin private pages and the admin host", () => {
  assert.equal(requiresSuperadminMfa(owner, "/account", "spaces.community"), true);
  assert.equal(requiresSuperadminMfa(owner, "/", "superadminko.spaces.community"), true);
  assert.equal(requiresSuperadminMfa("member@example.com", "/account", "spaces.community"), false);
});

test("auto-approves OAuth consent only for https Spaces service redirects", () => {
  assert.equal(isTrustedOAuthRedirect("https://tasks.spaces.community/api/v1/auth/sso/spaces/callback"), true);
  assert.equal(isTrustedOAuthRedirect("http://tasks.spaces.community/cb"), false);
  assert.equal(isTrustedOAuthRedirect("https://evil.com/?x=.spaces.community"), false);
  assert.equal(isTrustedOAuthRedirect("https://spaces.community.evil.com/cb"), false);
  assert.equal(isTrustedOAuthRedirect("https://user:pass@tasks.spaces.community/cb"), false);
  assert.equal(isTrustedOAuthRedirect("not a url"), false);
  assert.equal(requiresSuperadminMfa(owner, "/oauth/consent", "spaces.community"), true);
});
