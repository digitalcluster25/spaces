# Spaces Project Instructions

## Product Concept

Spaces is the main website and account hub for a set of approximately 20 separate services hosted on subdomains.

Core product requirements:
- One unified account from the main website for all Spaces services.
- Users must be able to manage connected services through an AI chat interface.
- The AI assistant needs controlled access to the user's data and service state.
- Knowledge retrieval should use a vector database where appropriate.

Architecture note:
- Do not store all application data only in a vector database.
- Use a primary structured database for accounts, permissions, service entities, billing, and operational state.
- Use a vector database for semantic search, embeddings, documentation, user knowledge, and AI retrieval.
- AI access must be permission-aware and scoped to the current user/account.

## Development Pipeline

Project repository:
- Local path: `/Users/macbookpro/Coding/spaces`
- GitHub: `https://github.com/digitalcluster25/spaces.git`
- Production domain: `spaces.community`

Required workflow:
1. Develop locally in `/Users/macbookpro/Coding/spaces`.
2. Run Playwright verification locally.
3. If verification passes, commit changes.
4. Push to GitHub.
5. Deployment to `spaces.community` happens automatically after push.

Do not push changes if Playwright verification fails.

## Production Deployment

Production host:
- Domain: `spaces.community`
- Server IP: `69.62.121.157`
- Root SSH access is available from this device by public key.
- Cloudflare zone ID: `a36d09a44859dc6ab0b44b195e665300`.
- Cloudflare nameservers: `emerie.ns.cloudflare.com`, `yew.ns.cloudflare.com`.
- Hostinger nameservers were replaced with Cloudflare nameservers on 2026-09-03.
- Public DNS now resolves through Cloudflare nameservers.

Current deployment:
- Static build is served by Docker container `spaces-site`.
- Container uses `nginx:alpine`.
- Traefik routes `Host(\`spaces.community\`)` to the container.
- Project files live in `/opt/spaces` on the server.
- Git checkout lives in `/opt/spaces/repo`.
- Built static files are served from `/opt/spaces/site`.
- SPA fallback for `/login`, `/register`, and `/forgot` is configured in `/opt/spaces/nginx.conf`.
- Auth routes are `/login`, `/register`, `/forgot`, `/reset-password`, and `/account`.

Supabase status:
- Supabase project `spaces` exists with ref `fnrzqmecumyagcajivsu`.
- Supabase CLI is linked to the project.
- Initial database migration has been applied.
- Email/password auth has been tested successfully.
- Profile creation trigger has been tested successfully.
- Local `.env` and production `/opt/spaces/repo/.env` contain frontend Supabase values.
- Resend SMTP is configured for Supabase Auth emails.
- Spaces Auth email templates are applied.
- Google OAuth is enabled and tested with `digitalcluster25@gmail.com`.
- Google Cloud project for OAuth is `spaces-504202`.
- Google app is published to production.
- Google branding is verified and is being shown to users.
- Supabase custom auth domain is not configured because it requires the Supabase Custom Domain add-on / paid plan.
- Required setup details are documented in `docs/supabase-setup.md`.

Autodeploy:
- `/opt/spaces/bin/deploy.sh` fetches `origin/main`, builds the project, syncs `dist/` into `/opt/spaces/site`, and restarts the container.
- `spaces-deploy.timer` runs the deploy service every minute.

## Connected Services

OpenSEO:
- URL: `https://openseo.spaces.community`
- Server path: `/opt/openseo`
- Container: `openseo`
- Image: `ghcr.io/every-app/open-seo:latest`
- Route is handled by Traefik with Let's Encrypt TLS.
- Docker self-host mode uses `AUTH_MODE=local_noauth`; public access is protected by Traefik Basic Auth until Spaces unified auth is connected.
- `DATAFORSEO_API_KEY` is configured in `/opt/openseo/.env`.
- Google Search Console API is enabled in Google Cloud project `spaces-504202`.
- Google Search Console OAuth is configured with redirect URI `https://openseo.spaces.community/api/gsc/oauth/callback`.
- OpenSEO project `Default` / `homewoodspa.com` is connected to Google Search Console property `https://homewoodspa.com/`.
- Optional AI features require `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` in `/opt/openseo/.env`.

OpenSEO Cloudflare MCP deployment:
- Local repo path: `/Users/macbookpro/Coding/open-seo`.
- Cloudflare account ID: `501500e8bf5a60f603060e9981cb09d3`.
- Cloudflare Workers subdomain: `digitalcluster25.workers.dev`.
- Zero Trust team domain: `https://dawn-snowflake-e7c2.cloudflareaccess.com`.
- Worker URL: `https://open-seo-selfhost.digitalcluster25-501.workers.dev`.
- MCP URL for ChatGPT/custom MCP clients: `https://openseo.spaces.community/mcp`.
- Fallback Worker MCP URL: `https://open-seo-selfhost.digitalcluster25-501.workers.dev/mcp`.
- Worker route prepared: `openseo.spaces.community/*` -> `open-seo-selfhost`.
- Cloudflare Access protects both `open-seo-selfhost.digitalcluster25-501.workers.dev` and `openseo.spaces.community`.
- Cloudflare Access application: `open-seo selfhost`.
- Cloudflare Access Managed OAuth is enabled for MCP clients.
- Dynamic client registration allows localhost, loopback, `https://chatgpt.com/*`, and `https://chat.openai.com/*`.
- Access allow-list currently includes `digitalcluster25@gmail.com`.
- Secrets live only in `/Users/macbookpro/Coding/open-seo/.env.selfhost`; never commit or print them.
