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

Current deployment:
- Static build is served by Docker container `spaces-site`.
- Container uses `nginx:alpine`.
- Traefik routes `Host(\`spaces.community\`)` to the container.
- Project files live in `/opt/spaces` on the server.
- Git checkout lives in `/opt/spaces/repo`.
- Built static files are served from `/opt/spaces/site`.
- SPA fallback for `/login`, `/register`, and `/forgot` is configured in `/opt/spaces/nginx.conf`.

Autodeploy:
- `/opt/spaces/bin/deploy.sh` fetches `origin/main`, builds the project, syncs `dist/` into `/opt/spaces/site`, and restarts the container.
- `spaces-deploy.timer` runs the deploy service every minute.
