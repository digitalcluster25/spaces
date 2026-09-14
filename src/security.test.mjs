import assert from "node:assert/strict";
import test from "node:test";
import { requiresSuperadminMfa } from "./security.ts";

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
