/** Extract a human-readable message from a $fetch/H3 error. */
export function apiErrorMessage(err: unknown): string {
  const e = err as { data?: { statusMessage?: string; message?: string }; statusMessage?: string; message?: string }
  return e?.data?.statusMessage || e?.statusMessage || e?.data?.message || e?.message || 'Request failed'
}
