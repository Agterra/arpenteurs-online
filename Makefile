# Deploy identifier baked into the image so the running app self-reports what's
# live (shown in-app + at /api/version). Git short sha, with a -dirty suffix if
# the tree has uncommitted changes; falls back to "dev" outside a git repo.
GIT_SHA := $(shell git rev-parse --short=7 HEAD 2>/dev/null)
GIT_DIRTY := $(shell git diff --quiet 2>/dev/null || echo -dirty)
BUILD_TAG := $(if $(GIT_SHA),$(GIT_SHA)$(GIT_DIRTY),dev)

deploy:
	BUILD_TAG=$(BUILD_TAG) docker --context homelab compose --env-file .env.deploy up -d --build

seed-database:
	docker --context homelab compose --env-file .env.deploy run --rm app node --max-old-space-size=4096 scripts/import-cards.ts
	docker --context homelab compose --env-file .env.deploy run --rm app node --max-old-space-size=4096 scripts/import-tokens.ts