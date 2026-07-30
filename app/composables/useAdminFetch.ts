/**
 * $fetch wrapper for /api/admin routes: on 401/403 the admin session is
 * missing/expired (or the backoffice is disabled) → bounce to the login page.
 *
 * `opts` is deliberately a loose bag rather than `Parameters<typeof $fetch>[1]`: that type is generic
 * over the typed route table, and resolving it here blows TypeScript's instantiation depth (TS2321).
 * The caller's `<T>` is the real contract for the response.
 */
export async function adminFetch<T>(url: string, opts?: Record<string, unknown>): Promise<T> {
  const fetcher = $fetch as unknown as (u: string, o?: Record<string, unknown>) => Promise<unknown>
  try {
    return (await fetcher(url, opts)) as T
  } catch (err) {
    const status = (err as { status?: number; statusCode?: number })?.status
      ?? (err as { statusCode?: number })?.statusCode
    if (status === 401 || status === 403) await navigateTo('/admin/login')
    throw err
  }
}
