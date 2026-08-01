# Supabase Setup for Spaces

Current state: the Spaces frontend is wired to a real Supabase project.

Project:
- Name: `spaces`
- Ref: `fnrzqmecumyagcajivsu`
- Region: `eu-west-3`
- Dashboard: `https://supabase.com/dashboard/project/fnrzqmecumyagcajivsu`

Completed:
- Supabase CLI is linked to project `fnrzqmecumyagcajivsu`.
- Database migration has been applied.
- Auth Site URL and redirect URLs have been pushed to Supabase.
- Local `.env` exists.
- Production `/opt/spaces/repo/.env` exists.
- Production site has been rebuilt with Supabase env values.
- Email/password sign up and sign in were tested successfully.
- `profiles` row creation trigger was tested successfully.

## Required project settings

Configured project settings:

- Site URL: `https://spaces.community`
- Redirect URLs:
  - `https://spaces.community/account`
  - `https://spaces.community/reset-password`
  - `http://localhost:5173/account`
  - `http://localhost:5173/reset-password`

## Google OAuth

In Google Cloud Console, create a Web OAuth client.

Authorized JavaScript origins:
- `https://spaces.community`
- `http://localhost:5173`

Authorized redirect URI:
- `https://<SUPABASE_PROJECT_REF>.supabase.co/auth/v1/callback`

Then enable Google provider in Supabase Auth and paste the Google client ID and secret there.

Google OAuth is not enabled yet because the Google OAuth client ID and secret have not been provided.

## Provider secrets handoff

Copy `.env.auth-providers.example` to `.env.auth-providers.local` and fill:

```bash
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_ADMIN_EMAIL=
SMTP_SENDER_NAME=Spaces
```

Do not commit `.env.auth-providers.local`.

## Trigger email status

Custom Spaces email templates are prepared in:

- `templates/confirmation.html`
- `templates/recovery.html`
- `templates/magic_link.html`
- `templates/email_change.html`
- `templates/password_changed_notification.html`

Supabase rejected applying custom templates on the free default email provider:

> Email template modification is not available for free tier projects using the default email provider. Please upgrade your plan or configure a custom SMTP provider.

Therefore production trigger emails require a custom SMTP provider before templates can be enabled.

## Environment variables

Local file:
- `/Users/macbookpro/Coding/spaces/.env`

Production file:
- `/opt/spaces/repo/.env` on `69.62.121.157`

Required values:

```bash
VITE_SUPABASE_URL=https://<SUPABASE_PROJECT_REF>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-public-key>
```

After changing production env values, run:

```bash
ssh root@69.62.121.157 'systemctl start spaces-deploy.service'
```

## Database

Apply migrations from:

```bash
supabase/migrations
```

The first migration creates:
- `profiles`
- `spaces_services`
- `service_memberships`
- `knowledge_documents` with `vector(1536)`
- RLS policies scoped to the current user
- trigger that creates a profile for every new auth user

References:
- Supabase redirect URLs: https://supabase.com/docs/guides/auth/redirect-urls
- Supabase Google auth: https://supabase.com/docs/guides/auth/social-login/auth-google
