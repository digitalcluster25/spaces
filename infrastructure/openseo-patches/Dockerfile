# syntax=docker/dockerfile:1.7
ARG BASE_IMAGE=openseo-spaces:base-20260912
FROM ${BASE_IMAGE}

ENV VITE_SHOW_DEVTOOLS=false

COPY infrastructure/openseo-patches/src/ /app/src/

RUN --mount=type=secret,id=openseo_env \
    set -a; . /run/secrets/openseo_env; set +a; \
    pnpm build; \
    fingerprint="$(env | grep -E '^(VITE_|AUTH_MODE|BYPASS_EMAIL_VERIFICATION|POSTHOG_PUBLIC_KEY|POSTHOG_HOST|TURNSTILE_SITE_KEY|POSTHOG_SOURCEMAPS)' | sort | sha256sum | cut -d' ' -f1)"; \
    printf '%s' "$fingerprint" > dist/.openseo-build-env
