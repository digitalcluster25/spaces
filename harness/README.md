# Spaces Harness

This package is the versioned contract for agent behavior across Spaces services.

- `SYSTEM_PROMPT.md` contains the immutable security and accuracy baseline.
- `defaults.json` is the editable baseline shown in the Spaces root project.
- `schema.json` documents the persisted configuration format.
- `evaluate.mjs` runs deterministic publication checks.
- `evaluate.test.mjs` protects the baseline and rejection rules.

Published database versions reference the Git revision containing this contract. User project settings are stored separately and cannot override administrative security, isolation, tooling, quality, runtime, or memory rules.
