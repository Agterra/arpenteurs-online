/**
 * $fetch wrapper for /api/admin routes: on 401/403 the admin session is
 * missing/expired (or the backoffice is disabled) → bounce to the login page.
 */
export async function adminFetch<T>(url: string, opts?: Parameters<typeof $fetch>[1]): Promise<T> {
  try {
    return (await $fetch(url, opts)) as T
  } catch (err) {
    const status = (err as { status?: number; statusCode?: number })?.status
      ?? (err as { statusCode?: number })?.statusCode
    if (status === 401 || status === 403) await navigateTo('/admin/login')
    throw err
  }
}
