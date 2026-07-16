/**
 * Reports the deployed version — the package.json semver baked at build. Handy
 * for `curl https://<host>/api/version` to confirm what's live. Like
 * /api/health, it deliberately does not touch the database.
 */
export default defineEventHandler(() => {
  const { version } = useRuntimeConfig().public
  return { version, ts: Date.now() }
})
