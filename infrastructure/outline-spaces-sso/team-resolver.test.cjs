const assert = require("node:assert/strict");
const test = require("node:test");
const { projectSubdomain, ensureOutlineTeam, findTeamForProject } = require("./team-resolver.js");

// Minimal in-memory stand-in for the Outline "teams" table, enough for the resolver's queries.
function fakeOutline(teams) {
  return {
    teams,
    async query(sql, params) {
      if (sql.includes(`"signupQueryParams"->>'spaces_project_id'`)) {
        const rows = teams.filter((t) => t.signupQueryParams?.spaces_project_id === params[0]);
        return { rows: rows.slice(0, 1), rowCount: Math.min(rows.length, 1) };
      }
      if (sql.startsWith("select id from teams where subdomain")) {
        const rows = teams.filter((t) => t.subdomain === params[0]);
        return { rows, rowCount: rows.length };
      }
      if (sql.startsWith("update teams")) {
        const team = teams.find((t) => t.id === params[1]);
        Object.assign(team, { name: params[0], deletedAt: null, suspendedAt: null });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("insert into teams")) {
        teams.push({ id: params[0], name: params[1], subdomain: params[2], signupQueryParams: JSON.parse(params[3]) });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const HWS = "cabe6eb0-68f5-4437-ad74-57b3d6c87dcd";
const OTHER = "99999999-8888-4777-8666-555555555555";

function productionLike() {
  return fakeOutline([
    { id: "team-main", subdomain: "spaces", name: "Home Wood Spa", signupQueryParams: { spaces_project_id: HWS }, deletedAt: null },
    { id: "team-spaces", subdomain: "spaces-spaces-f1857726", name: "Spaces", signupQueryParams: { spaces_project_id: "f1857726-60e0-42ee-afd0-67b893f1ef6d" } },
  ]);
}

test("the main team is found only through its bound project id", async () => {
  const db = productionLike();
  assert.equal(await ensureOutlineTeam(db, { id: HWS, name: "Home Wood Spa", slug: "commercial-projects" }), "team-main");
  assert.equal((await findTeamForProject(db, HWS)).id, "team-main");
});

test("another account's project with the same slug gets its own team, never the main one (C1)", async () => {
  const db = productionLike();
  const teamId = await ensureOutlineTeam(db, { id: OTHER, name: "Чужой проект", slug: "commercial-projects" });
  assert.notEqual(teamId, "team-main");
  const created = db.teams.find((t) => t.id === teamId);
  assert.equal(created.subdomain, "spaces-commercial-projects-99999999");
  assert.equal(created.signupQueryParams.spaces_project_id, OTHER);
  assert.equal(db.teams.find((t) => t.id === "team-main").name, "Home Wood Spa");
  // lifecycle operations of the other project never reach the main team
  assert.equal(await findTeamForProject(db, "00000000-0000-4000-8000-000000000000"), null);
});

test("a free subdomain that is already taken by an unbound team is refused, not adopted", async () => {
  const db = productionLike();
  db.teams.push({ id: "squatter", subdomain: projectSubdomain("x", OTHER), name: "x", signupQueryParams: {} });
  await assert.rejects(ensureOutlineTeam(db, { id: OTHER, name: "X", slug: "x" }), /taken by another tenant/);
});

test("subdomains are normalised", () => {
  assert.match(projectSubdomain("Мой Проект!", "abcdef12-0000-4000-8000-000000000000"), /^spaces--+abcdef12$/);
  assert.equal(projectSubdomain("ok-slug", "abcdef12-3456"), "spaces-ok-slug-abcdef12");
});
