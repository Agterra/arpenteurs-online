# Changelog

All notable changes to Arpenteurs are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The running app reports its version in-app (bottom-right badge) and at
`/api/version`: `version` is this file's current release, `buildTag` is the
git short sha / image tag it was built from.

## [Unreleased]

## [1.0.0] - 2026-07-16

First deployed release.

### Added
- Homelab deploy stack: `docker-compose.yml` serves the app through the shared
  external `proxy` network behind the standalone Traefik (TLS via Let's Encrypt),
  with a one-shot `migrate` service (`prisma migrate deploy`) and a loopback-only
  Postgres. `make deploy` / `make seed-database` wrap it.
- Version tracking: the `package.json` semver is the single version identifier —
  it tags the built image (`arpenteurs-app:<version>`) and is surfaced via an
  in-app badge and the `/api/version` endpoint. Bump `package.json` to release.
- Catalog import scripts (`scripts/import-cards.ts`, `scripts/import-tokens.ts`)
  are shipped in the runtime image so the deployed DB can be seeded with
  `make seed-database`.
