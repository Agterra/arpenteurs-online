# Human-readable app version, from package.json. This is the single version
# identifier: it tags the built image (arpenteurs-app:$(APP_VERSION)) and is what
# the app reports in-app + at /api/version. Bump package.json to release.
APP_VERSION := $(shell node -p "require('./package.json').version" 2>/dev/null || echo dev)
export APP_VERSION

deploy:
	docker --context homelab compose --env-file .env.deploy up -d --build

seed-database:
	docker --context homelab compose --env-file .env.deploy run --rm app node --max-old-space-size=4096 scripts/import-cards.ts
	docker --context homelab compose --env-file .env.deploy run --rm app node --max-old-space-size=4096 scripts/import-tokens.ts