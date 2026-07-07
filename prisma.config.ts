import { defineConfig } from 'prisma/config'

// Prisma 7 no longer auto-loads .env when a config file is present.
// Node 24's native loader keeps us dependency-free; ignore if .env is absent (CI/prod).
try {
  process.loadEnvFile('.env')
} catch {
  // .env not present — rely on real environment variables
}

// `prisma generate` (e.g. during `docker build`) evaluates this config but does
// NOT connect, so DATABASE_URL may be unset there. Use a placeholder fallback so
// generate never throws; the real URL is present at deploy time when
// `prisma migrate deploy` runs (injected via the k8s Secret). Note: we read
// process.env directly rather than prisma's env() helper, which throws on a
// missing variable.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? 'postgresql://placeholder:placeholder@localhost:5432/placeholder',
  },
})
