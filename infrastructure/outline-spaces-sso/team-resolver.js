// SPC-0010: Outline team ↔ Spaces project mapping.
// A team belongs to a project only through teams."signupQueryParams".spaces_project_id.
// The project slug never selects an existing team (slugs are per account and can repeat
// across accounts); it is used only to name the subdomain of a NEW team, together with
// the project id prefix.

function projectSubdomain(projectSlug, projectId) {
  const slug = String(projectSlug || "project").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 70);
  return `spaces-${slug}-${String(projectId).replace(/-/g, "").slice(0, 8)}`;
}

async function findTeamForProject(client, projectId) {
  const result = await client.query(
    `select id, subdomain from teams where "signupQueryParams"->>'spaces_project_id' = $1 order by "createdAt" limit 1`,
    [String(projectId)],
  );
  return result.rows[0] || null;
}

async function ensureOutlineTeam(client, project) {
  const existing = await findTeamForProject(client, project.id);
  if (existing) {
    await client.query(
      'update teams set name = $1, "deletedAt" = null, "suspendedAt" = null, "updatedAt" = now() where id = $2',
      [project.name, existing.id],
    );
    return existing.id;
  }

  const subdomain = projectSubdomain(project.slug, project.id);
  const taken = await client.query('select id from teams where subdomain = $1 limit 1', [subdomain]);
  if (taken.rowCount) {
    // A team with this name exists but is not bound to this project: never adopt it.
    throw new Error("Outline subdomain is taken by another tenant");
  }
  const teamId = require("crypto").randomUUID();
  await client.query(
    `insert into teams
      (id, name, "createdAt", "updatedAt", subdomain, sharing, "documentEmbeds", "guestSignin",
       "defaultUserRole", "memberCollectionCreate", "inviteRequired", "memberTeamCreate", "passkeysEnabled", "signupQueryParams")
     values ($1, $2, now(), now(), $3, true, true, false, 'member', true, false, true, false, $4::jsonb)`,
    [teamId, project.name, subdomain, JSON.stringify({ spaces_project_id: project.id })],
  );
  return teamId;
}

module.exports = { projectSubdomain, findTeamForProject, ensureOutlineTeam };
