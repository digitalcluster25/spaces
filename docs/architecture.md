# Spaces Architecture

Spaces is the account hub for project services hosted on subdomains.

## Current Goal

Build one account system and a modular service environment where external AI
agents can connect to authorized services through MCP. Spaces owns identity,
service discovery, permissions, and launch flow. A native Spaces chat with
agents comes later, after external MCP access is proven.

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

## Agent Access Contract

Agents never receive blanket access by default.

Every external agent or MCP request must resolve:
- signed-in user;
- active organization;
- user role;
- service connection;
- allowed read tools;
- allowed write tools;
- whether confirmation is required.

Agents may read low-risk service data after permission checks.
Write actions must be recorded as `ai_action` and require explicit user
confirmation unless the action is marked safe and reversible.

The first integration target is external agents connecting their own MCP client
to a Spaces-authorized service. Native Spaces chat is a later frontend for the
same permissioned service layer.

## Service Integration Contract

Each service should expose the same integration shape:

- `id`: stable service key, for example `openseo`.
- `name`: display name.
- `base_url`: user-facing URL.
- `status`: `available`, `connected`, `needs_setup`, `error`.
- `auth_mode`: `spaces_supabase`, `cloudflare_access`, `oauth`, `api_key`, or
  `manual`.
- `mcp_url`: optional MCP endpoint.
- `required_secrets`: names only, never values.
- `health_check`: a read-only status check.
- `tools`: list of AI-callable read/write actions.

## First Service: OpenSEO

OpenSEO is the first connected service.

Current production paths:
- Human UI: `https://openseo.spaces.community` on the VPS Docker deployment.
- MCP/AI path: `https://openseo.spaces.community/mcp` through Cloudflare
  Access Managed OAuth.

Fallback MCP path:
- `https://open-seo-selfhost.digitalcluster25-501.workers.dev/mcp`.

## Current Spaces UI State

The account page now includes:
- auth session status from Supabase;
- a connected services directory;
- OpenSEO as the first service entry;
- OpenSEO UI and MCP links;
- an external-agent MCP status surface.

The old "native chat first" direction is deprecated. The immediate product
path is: sign in to Spaces, see available services in the dashboard, launch
OpenSEO without a second login, and connect external agents to OpenSEO MCP under
the same Spaces account. Native Spaces chat comes after this agent/service
contract works in production.

## Near-Term Implementation Order

1. Make the Spaces dashboard the source of service discovery and launch.
2. Replace OpenSEO's current independent self-host auth with Spaces/Supabase
   SSO.
3. Ensure one Spaces user maps to the same OpenSEO user and organization.
4. Verify dashboard launch: signed-in Spaces user opens OpenSEO without a
   second login.
5. Verify external-agent MCP connection uses the same authorized user context.
6. Add audit logging for every MCP request and proposed action.
7. Add native Spaces chat only after OpenSEO MCP works reliably through external
   agents.
