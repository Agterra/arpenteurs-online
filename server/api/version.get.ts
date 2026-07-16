/**
 * Reports the deployed version. `version` is the package.json semver baked at
 * build; `buildTag` is the deploy identifier (git short sha / image tag) from
 * NUXT_PUBLIC_BUILD_TAG. Handy for `curl https://<host>/api/version` to confirm
 * what's live. Like /api/health, it deliberately does not touch the database.
 */
export default defineEventHandler(() => {
  const { version, buildTag } = useRuntimeConfig().public
  return { version, buildTag, ts: Date.now() }
})
