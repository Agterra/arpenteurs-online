/**
 * Enforced-mode client store. The server pushes the FULL redacted state
 * ({ t: 'rstate' }) after every action, so there is no delta/seq reconciliation
 * — the latest rstate is the truth. Card display data (images, costs) is
 * fetched lazily from /api/cards/display, keyed by defName (= Card.nameNorm).
 */
import { defineStore } from 'pinia'
import type { PlayerId, RulesClientState } from '#shared/rules/types'

export interface RulesCardDisplay {
  name: string
  manaCost: string | null
  typeLine: string
  oracleText: string | null
  imageSmall: string | null
  imageNormal: string | null
  power: string | null
  toughness: string | null
}

export interface RulesLastError {
  code: string
  message: string
  at: number
}

export const useRulesGameStore = defineStore('rulesGame', {
  state: () => ({
    state: null as RulesClientState | null,
    /** defName → display data (from /api/cards/display); missing keys not yet fetched */
    display: {} as Record<string, RulesCardDisplay>,
    lastError: null as RulesLastError | null,
    _fetching: {} as Record<string, true>,
  }),

  getters: {
    you: (s): PlayerId | null => s.state?.you ?? null,
    opponentId: (s): PlayerId | null =>
      s.state ? (s.state.turnOrder.find((p) => p !== s.state!.you) ?? null) : null,
    isMyPriority: (s): boolean => !!s.state && s.state.priorityPlayer === s.state.you,
  },

  actions: {
    applyRState(state: RulesClientState) {
      this.state = state
      void this.fetchMissingDisplays()
    },

    setError(code: string, message: string) {
      this.lastError = { code, message, at: Date.now() }
    },

    /** Fetch display data for defNames present in the state but not yet cached. */
    async fetchMissingDisplays() {
      const st = this.state
      if (!st) return
      const missing = new Set<string>()
      const want = (defName: string | null | undefined) => {
        if (defName && !(defName in this.display) && !(defName in this._fetching)) missing.add(defName)
      }
      for (const card of Object.values(st.cards)) want(card.defName)
      for (const item of st.zones.stack) want(item.defName)
      if (!missing.size) return

      const names = [...missing]
      for (const n of names) this._fetching[n] = true
      try {
        const res = await $fetch<{ cards: Record<string, RulesCardDisplay> }>('/api/cards/display', {
          method: 'POST',
          body: { names },
        })
        for (const [k, v] of Object.entries(res.cards)) this.display[k] = v
      } catch {
        // transient — the next rstate retries missing names
      } finally {
        for (const n of names) delete this._fetching[n]
      }
    },

    reset() {
      this.state = null
      this.display = {}
      this.lastError = null
      this._fetching = {}
    },
  },
})
