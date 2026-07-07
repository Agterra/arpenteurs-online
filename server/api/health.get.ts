/**
 * Liveness/readiness probe target. Deliberately does NOT touch the database —
 * a DB blip should not cause k8s to kill the app pod (the in-memory game rooms
 * live in that single process; see the replicas:1 note in the Helm chart).
 */
export default defineEventHandler(() => ({ ok: true, ts: Date.now() }))
