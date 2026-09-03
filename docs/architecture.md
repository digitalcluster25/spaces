# Spaces Architecture

Spaces is the account hub for project services hosted on subdomains.

## Current Goal

Build one account system, one service directory, and one AI control surface that
can safely operate connected services for the signed-in user.

## Core Entities

- `user`: a Supabase Auth user.
- `profile`: public account metadata for a user.
- `organization`: billing and ownership boundary. A user may own or join one or
  more organizations.
- `membership`: user role inside an organization.
- `service`: a product connected to Spaces, for example OpenSEO.
- `service_connection`: per-organization connection state for one service.
- `service_credential`: encrypted credential or OAuth reference used by a
  service integration.
- `ai_thread`: a user-visible chat thread.
- `ai_action`: one tool/action proposed or executed by AI.
- `audit_event`: immutable log of sensitive auth, credential, service, and AI
  actions.

## Data Boundaries

Use Supabase Postgres as the source of truth for:
- accounts, profiles, organizations, memberships;
- service registry and connection state;
- permissions, audit logs, billing state;
- IDs that link to external services.

Use vector storage only for:
- semantic search;
- service documentation;
- user-provided knowledge;
- indexed summaries and retrieval context for AI.

Do not store authoritative permissions, billing, credentials, or service state
only in a vector database.

## Roles

- `owner`: can manage billing, users, credentials, and service connections.
- `admin`: can manage services and AI actions, but not billing ownership.
- `member`: can use connected services allowed by the organization.
- `viewer`: read-only access.

## AI Access Contract

AI never receives blanket access by default.

Every AI request must resolve:
- signed-in user;
- active organization;
- user role;
- service connection;
- allowed read tools;
- allowed write tools;
- whether confirmation is required.

AI may read low-risk service data after permission checks.
AI write actions must be recorded as `ai_action` and require explicit user
confirmation unless the action is marked safe and reversible.

## Service Integration Contract

Each service should expose the same integration shape:

- `id`: stable service key, for example `openseo`.
- `name`: display name.
- `base_url`: user-facing URL.
- `status`: `available`, `connected`, `needs_setup`, `error`.
- `auth_mode`: `spaces_session`, `cloudflare_access`, `oauth`, `api_key`, or
  `manual`.
- `mcp_url`: optional MCP endpoint.
- `required_secrets`: names only, never values.
- `health_check`: a read-only status check.
- `tools`: list of AI-callable read/write actions.

## First Service: OpenSEO

OpenSEO is the first connected service.

Current production paths:
- Human UI: `https://openseo.spaces.community` on the VPS Docker deployment.
- MCP/AI path: `https://open-seo-selfhost.digitalcluster25-501.workers.dev/mcp`
  through Cloudflare Access Managed OAuth.

Target path:
- Move MCP to `https://openseo.spaces.community/mcp` after
  `spaces.community` finishes Cloudflare nameserver propagation and Access
  accepts the custom domain.

## Near-Term Implementation Order

1. Finish Cloudflare DNS activation for `spaces.community`.
2. Move OpenSEO MCP from `workers.dev` to `openseo.spaces.community`.
3. Add a service registry to Spaces.
4. Add an account dashboard that shows connected services.
5. Register OpenSEO as the first service.
6. Add a minimal AI chat surface with read-only service status tools.
7. Add confirmed write actions only after audit logging exists.
