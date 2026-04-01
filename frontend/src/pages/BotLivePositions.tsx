import { useState, useEffect, useRef } from 'react'
import { apiFetch } from '../apiClient'

export type Position = {
  ticket: number
  symbol: string
  type: string
  volume: number
  price_open: number
  sl: number
  tp: number
  profit: number
  comment: string
}

export type AccountPositions = {
  account_id: string
  label: string
  positions: Position[]
}

export type HedgePair = {
  ticket_0: number
  account_0: string
  ticket_1: number
  account_1: string
  symbol: string
  created_at: string
  type_0?: string
  type_1?: string
  sl_pips_0?: number
  tp_pips_0?: number
  sl_pips_1?: number
  tp_pips_1?: number
}

const API = '/api'
const CLOSE_ALL_THRESHOLD_KEY = 'livepositions_close_all_threshold'
const SWAP_AVOID_KEY = 'livepositions_swap_avoid'
const SWAP_LAST_CLOSED_KEY = 'livepositions_swap_last_closed'
const LIVEPOSITIONS_ACCOUNTS_KEY = 'livepositions_selected_accounts'

function loadCloseAllThreshold(): string {
  try {
    const s = localStorage.getItem(CLOSE_ALL_THRESHOLD_KEY)
    if (s != null && s.trim() !== '') return s.trim()
  } catch (_) {}
  return '0'
}

type SwapAvoidConfig = {
  hourUtc: number
  minuteUtc: number
  minutesBefore: number
  enabled: boolean
}

const DEFAULT_SWAP_AVOID: SwapAvoidConfig = {
  hourUtc: 22,
  minuteUtc: 0,
  minutesBefore: 5,
  enabled: false,
}

function loadSwapAvoidConfig(): SwapAvoidConfig {
  try {
    const s = localStorage.getItem(SWAP_AVOID_KEY)
    if (s) {
      const o = JSON.parse(s)
      return {
        hourUtc: Math.max(0, Math.min(23, Number(o.hourUtc) ?? 22)),
        minuteUtc: Math.max(0, Math.min(59, Number(o.minuteUtc) ?? 0)),
        minutesBefore: Math.max(1, Math.min(60, Number(o.minutesBefore) ?? 5)),
        enabled: !!o.enabled,
      }
    }
  } catch (_) {}
  return DEFAULT_SWAP_AVOID
}

/** Next rollover time in UTC (as Date). */
function getNextRolloverUtc(hourUtc: number, minuteUtc: number): Date {
  const now = new Date()
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, minuteUtc, 0, 0))
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1)
  }
  return next
}

/** Date string for rollover (YYYY-MM-DD) for dedupe. */
function rolloverDateKey(next: Date): string {
  return next.toISOString().slice(0, 10)
}

type Props = {
  accounts?: { id: string; label: string }[]
  results?: AccountPositions[]
  lastUpdate?: Date | null
  connected?: boolean
  onRefreshPairs?: () => void | Promise<void>
}

function normAccount(a: string): string {
  return String(a ?? '').trim().toLowerCase()
}

export default function BotLivePositions({ accounts: accountsProp = [], results: resultsProp = [], lastUpdate: lastUpdateProp = null, connected: connectedProp = false, onRefreshPairs }: Props) {
  const [results, setResults] = useState<AccountPositions[]>(resultsProp)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(lastUpdateProp)
  const [connected, setConnected] = useState(connectedProp)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const accountMenuRef = useRef<HTMLDivElement>(null)
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(LIVEPOSITIONS_ACCOUNTS_KEY)
      const parsed = raw ? (JSON.parse(raw) as unknown) : null
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  })
  const hasClosedForPositiveRef = useRef(false)
  const [closeAllWhenPnlAbove, setCloseAllWhenPnlAbove] = useState(loadCloseAllThreshold)

  const [swapAvoid, setSwapAvoid] = useState<SwapAvoidConfig>(loadSwapAvoidConfig)
  const [countdownMs, setCountdownMs] = useState<number | null>(null)
  const lastClosedRolloverRef = useRef<string | null>((() => {
    try {
      return localStorage.getItem(SWAP_LAST_CLOSED_KEY)
    } catch (_) {
      return null
    }
  })())

  useEffect(() => {
    try {
      localStorage.setItem(CLOSE_ALL_THRESHOLD_KEY, closeAllWhenPnlAbove)
    } catch (_) {}
  }, [closeAllWhenPnlAbove])

  useEffect(() => {
    try {
      localStorage.setItem(LIVEPOSITIONS_ACCOUNTS_KEY, JSON.stringify(selectedAccountIds))
    } catch (_) {}
  }, [selectedAccountIds])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(e.target as Node)) {
        setAccountMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(SWAP_AVOID_KEY, JSON.stringify(swapAvoid))
    } catch (_) {}
  }, [swapAvoid])

  // Countdown to next swap (update every second)
  useEffect(() => {
    const next = getNextRolloverUtc(swapAvoid.hourUtc, swapAvoid.minuteUtc)
    const tick = () => {
      const ms = next.getTime() - Date.now()
      setCountdownMs(ms > 0 ? ms : 0)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [swapAvoid.hourUtc, swapAvoid.minuteUtc])

  // Auto-close all positions X minutes before swap (once per rollover); check every 30s
  useEffect(() => {
    if (!swapAvoid.enabled) return
    const interval = setInterval(() => {
      const scoped = selectedAccountIds.length > 0
        ? results.filter((a) => selectedAccountIds.includes(a.account_id))
        : results
      const total = scoped.reduce((n, a) => n + a.positions.length, 0)
      if (total === 0) return
      const next = getNextRolloverUtc(swapAvoid.hourUtc, swapAvoid.minuteUtc)
      const closeAt = next.getTime() - swapAvoid.minutesBefore * 60 * 1000
      if (Date.now() < closeAt) return
      const key = rolloverDateKey(next)
      if (lastClosedRolloverRef.current === key) return
      lastClosedRolloverRef.current = key
      try {
        localStorage.setItem(SWAP_LAST_CLOSED_KEY, key)
      } catch (_) {}
      apiFetch(`${API}/positions/close-all`, { method: 'POST' })
        .then((r) => r.json().catch(() => ({})))
        .then((data) => {
          if (data?.ok) onRefreshPairs?.()
        })
    }, 30_000)
    return () => clearInterval(interval)
  }, [swapAvoid.enabled, swapAvoid.hourUtc, swapAvoid.minuteUtc, swapAvoid.minutesBefore, results, selectedAccountIds, onRefreshPairs])

  useEffect(() => {
    setResults(resultsProp)
    setLastUpdate(lastUpdateProp)
    setConnected(connectedProp)
  }, [resultsProp, lastUpdateProp, connectedProp])

  const allAccountsForFilter: { id: string; label: string }[] = (
    accountsProp.length > 0
      ? accountsProp
      : results.map((r) => ({ id: r.account_id, label: r.label }))
  ).filter((a, i, arr) => arr.findIndex((x) => x.id === a.id) === i)

  useEffect(() => {
    if (allAccountsForFilter.length === 0) return
    setSelectedAccountIds((prev) => {
      const valid = prev.filter((id) => allAccountsForFilter.some((a) => a.id === id))
      return valid.length > 0 ? valid : allAccountsForFilter.map((a) => a.id)
    })
  }, [accountsProp.length, results.length])

  const toggleAccountId = (id: string) => {
    setSelectedAccountIds((prev) => {
      if (prev.includes(id)) {
        if (prev.length <= 1) return prev
        return prev.filter((x) => x !== id)
      }
      return [...prev, id]
    })
  }

  const selectedAccountSet = new Set(selectedAccountIds.map((id) => normAccount(id)))
  const filteredResults =
    selectedAccountSet.size > 0
      ? results.filter((r) => selectedAccountSet.has(normAccount(r.account_id)))
      : results

  const totalCount = filteredResults.reduce((n, a) => n + a.positions.length, 0)

  // Group all positions by symbol: symbol -> { account, position }[]
  const bySymbol = new Map<string, { account: AccountPositions; position: Position }[]>()
  for (const account of filteredResults) {
    for (const position of account.positions) {
      const sym = position.symbol
      if (!bySymbol.has(sym)) bySymbol.set(sym, [])
      bySymbol.get(sym)!.push({ account, position })
    }
  }

  const combinedPnl = filteredResults.reduce(
    (sum, a) => sum + a.positions.reduce((s, p) => s + (p.profit ?? 0), 0),
    0
  )

  const closeAllThreshold = Number(closeAllWhenPnlAbove)
  const thresholdValid = Number.isFinite(closeAllThreshold)

  function formatCountdown(ms: number | null): string {
    if (ms == null || ms <= 0) return '—'
    const totalSec = Math.floor(ms / 1000)
    const h = Math.floor(totalSec / 3600)
    const m = Math.floor((totalSec % 3600) / 60)
    const s = totalSec % 60
    if (h > 0) return `${h}h ${m}m ${s}s`
    if (m > 0) return `${m}m ${s}s`
    return `${s}s`
  }

  // When Overall P/L reaches or exceeds the threshold, close all positions once (reset when P/L goes below threshold or when no positions)
  useEffect(() => {
    const thresh = thresholdValid ? closeAllThreshold : 0
    if (combinedPnl < thresh || totalCount === 0) {
      hasClosedForPositiveRef.current = false
      if (totalCount === 0) return
    }
    if (combinedPnl < thresh) return
    if (totalCount > 0 && !hasClosedForPositiveRef.current) {
      hasClosedForPositiveRef.current = true
      apiFetch(`${API}/positions/close-selected`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_ids: selectedAccountIds }),
      })
        .then((r) => r.json().catch(() => ({})))
        .then((data) => {
          if (data?.ok) {
            onRefreshPairs?.()
          } else {
            // Allow retry on next cycle if close request fails.
            hasClosedForPositiveRef.current = false
          }
        })
        .catch(() => {
          hasClosedForPositiveRef.current = false
        })
    }
  }, [combinedPnl, totalCount, onRefreshPairs, closeAllThreshold, thresholdValid, selectedAccountIds])

  const symbols = Array.from(bySymbol.keys()).sort()

  const renderSectionForSymbol = (symbol: string) => {
    const rows = bySymbol.get(symbol) ?? []
    const sectionProfit = rows.reduce((s, r) => s + (r.position.profit ?? 0), 0)
    return (
      <section key={symbol} className="live-positions-section">
        <h3 className="live-section-title">{symbol}</h3>
        <p className="live-section-label">
          <span className="live-section-pnl">
            P/L:{' '}
            <span className={sectionProfit >= 0 ? 'profit' : 'loss'}>
              {(sectionProfit >= 0 ? '+' : '') + sectionProfit.toFixed(2)}
            </span>
          </span>
        </p>
        <div className="dashboard-table-wrap">
          <table className="dashboard-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Type</th>
                <th>Volume</th>
                <th>Price open</th>
                <th>P/L</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ account, position: p }) => {
                const accountId = account.account_id
                const priceDecimals = p.symbol.includes('JPY') ? 2 : 5
                return (
                  <tr key={`${accountId}-${p.ticket}`}>
                    <td>{account.label}</td>
                    <td>
                      <span className={p.type}>{p.type}</span>
                    </td>
                    <td>{p.volume}</td>
                    <td>{Number(p.price_open).toFixed(priceDecimals)}</td>
                    <td className={p.profit >= 0 ? 'profit' : 'loss'}>
                      {(p.profit >= 0 ? '+' : '') + (p.profit ?? 0).toFixed(2)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    )
  }

  return (
    <div className="card">
      <div className="live-page-header">
        <div>
          <h2 className="live-page-title">Live positions</h2>
          {allAccountsForFilter.length > 0 && (
            <div className="account-multiselect" ref={accountMenuRef} style={{ marginTop: '0.5rem' }}>
              <label id="livepositions-account-filter-label">Accounts</label>
              <button
                type="button"
                className="account-multiselect-toggle"
                aria-expanded={accountMenuOpen}
                aria-haspopup="listbox"
                aria-labelledby="livepositions-account-filter-label"
                onClick={() => setAccountMenuOpen((o) => !o)}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {selectedAccountIds.length === allAccountsForFilter.length
                    ? 'All accounts'
                    : `${selectedAccountIds.length} selected`}
                </span>
                <span className="caret" aria-hidden>
                  ▾
                </span>
              </button>
              {accountMenuOpen && (
                <div className="account-multiselect-panel" role="listbox" aria-multiselectable>
                  {allAccountsForFilter.map((a) => (
                    <label key={a.id} className="account-multiselect-option">
                      <input
                        type="checkbox"
                        checked={selectedAccountIds.includes(a.id)}
                        onChange={() => toggleAccountId(a.id)}
                      />
                      <span>{a.label}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
          <p className="live-status">
            <span className={connected ? 'connected' : 'disconnected'}>
              {connected ? '● Live' : '○ Disconnected'}
            </span>
            {lastUpdate && (
              <span className="last-update">
                Last update: {lastUpdate.toLocaleTimeString()}
              </span>
            )}
          </p>
          {totalCount === 0 && !connected && (
            <p className="empty">Connecting to live feed…</p>
          )}
          {totalCount === 0 && connected && filteredResults.length === 0 && (
            <p className="empty">Selected accounts are not in the live feed yet.</p>
          )}
          {totalCount === 0 && connected && filteredResults.length > 0 && (
            <p className="empty">No open positions on selected accounts.</p>
          )}
        </div>
        <div className="live-swap-card">
        <h3 className="live-swap-title">Swap avoidance</h3>
        <p className="settings-hint live-swap-desc">
          Broker charges swap at rollover (e.g. IC Markets: 22:00 UTC / 5pm NY). Enable to close all positions a few minutes before rollover to avoid swap fee.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '1rem', marginBottom: '0.5rem' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="checkbox"
              checked={swapAvoid.enabled}
              onChange={(e) => setSwapAvoid((c) => ({ ...c, enabled: e.target.checked }))}
            />
            Auto-close before swap
          </label>
          <span className="live-inline-input-group">
            <label htmlFor="swap-rollover-utc">Rollover (UTC)</label>
            <input
              id="swap-rollover-utc"
              type="number"
              min={0}
              max={23}
              value={swapAvoid.hourUtc}
              onChange={(e) => setSwapAvoid((c) => ({ ...c, hourUtc: Math.max(0, Math.min(23, Number(e.target.value) || 0)) }))}
              style={{ width: '3rem', padding: '0.25rem' }}
            />
            :
            <input
              type="number"
              min={0}
              max={59}
              value={swapAvoid.minuteUtc}
              onChange={(e) => setSwapAvoid((c) => ({ ...c, minuteUtc: Math.max(0, Math.min(59, Number(e.target.value) || 0)) }))}
              style={{ width: '3rem', padding: '0.25rem' }}
            />
          </span>
          <span className="live-inline-input-group">
            <label htmlFor="swap-close-before">Close</label>
            <input
              id="swap-close-before"
              type="number"
              min={1}
              max={60}
              value={swapAvoid.minutesBefore}
              onChange={(e) => setSwapAvoid((c) => ({ ...c, minutesBefore: Math.max(1, Math.min(60, Number(e.target.value) || 5)) }))}
              style={{ width: '3rem', padding: '0.25rem' }}
            />
            <span>min before</span>
          </span>
        </div>
        <p className="live-totals" style={{ marginBottom: 0 }}>
          <strong>Next swap in:</strong>{' '}
          <span className={countdownMs != null && countdownMs < swapAvoid.minutesBefore * 60 * 1000 ? 'loss' : undefined}>
            {formatCountdown(countdownMs)}
          </span>
          {swapAvoid.enabled && totalCount > 0 && (
            <span className="settings-hint" style={{ marginLeft: '0.5rem' }}>
              (positions will close {swapAvoid.minutesBefore} min before rollover)
            </span>
          )}
        </p>
        </div>
      </div>

      {filteredResults.length > 0 && (
        <>
          <div className="live-totals-row">
            <p className="live-totals live-totals-combined live-total-chip overall" title="Sum of P/L across all open positions in selected accounts">
              Overall P/L:{' '}
              <span className={combinedPnl >= 0 ? 'profit' : 'loss'}>
                {(combinedPnl >= 0 ? '+' : '') + combinedPnl.toFixed(2)}
              </span>
            </p>
            <p className="live-totals live-total-chip live-threshold-chip">
              <label htmlFor="close-all-threshold">Close all when P/L ≥ ($)</label>
              <input
                id="close-all-threshold"
                type="text"
                inputMode="decimal"
                placeholder="0"
                value={closeAllWhenPnlAbove}
                onChange={(e) => setCloseAllWhenPnlAbove(e.target.value)}
                style={{ width: '6rem', padding: '0.25rem 0.5rem' }}
                title="When Overall P/L reaches this amount (or more), all positions are closed once. Use 0 for any profit; reset when P/L drops below this."
              />
            </p>
          </div>
          <div className="live-positions-sections">
            {symbols.map((symbol) => renderSectionForSymbol(symbol))}
          </div>
        </>
      )}

    </div>
  )
}
