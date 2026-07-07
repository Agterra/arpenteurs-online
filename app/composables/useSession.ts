export interface SessionUser {
  id: string
  username: string
}

/**
 * Session state wrapper around GET /api/auth/me.
 * Call `refresh()` once (e.g. via useAsyncData) to hydrate; `claim`/`rename`
 * update the shared state in place.
 */
export function useSession() {
  const user = useState<SessionUser | null>('session-user', () => null)
  const loaded = useState<boolean>('session-loaded', () => false)
  // Forwards the sid cookie during SSR; plain $fetch on the client.
  const requestFetch = useRequestFetch()

  async function refresh() {
    const data = await requestFetch<{ user: SessionUser | null }>('/api/auth/me')
    user.value = data.user
    loaded.value = true
  }

  async function claim(username: string) {
    const data = await $fetch<{ user: SessionUser }>('/api/auth/claim', {
      method: 'POST',
      body: { username },
    })
    user.value = data.user
    loaded.value = true
    return data.user
  }

  async function rename(username: string) {
    const data = await $fetch<{ user: SessionUser }>('/api/auth/me', {
      method: 'PATCH',
      body: { username },
    })
    user.value = data.user
    return data.user
  }

  return { user, loaded, refresh, claim, rename }
}
