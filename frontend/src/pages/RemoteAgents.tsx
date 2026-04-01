import { useState, useEffect, useCallback, useRef } from 'react'
import { apiFetch, appendPanelKeyToWsUrl } from '../apiClient'

const API = '/api'
const ADMIN_KEY_STORAGE = 'mt5bot_agent_admin_key'

type DeviceRow = {
  device_id: string
  label: string
  last_heartbeat_unix: number
  last_agent_version: string
  last_mt5_connected: boolean
  probably_online: boolean
  worker_enabled?: boolean
  worker_next_run_unix?: number
}

type CommandRow = {
  id: string
  device_id: string
  type?: string
  cmd_type?: string
  status: string
  created_unix: number
  result?: unknown
}

export default function RemoteAgents() {
  const [adminKey, setAdminKey] = useState(() => {
    try {
      const s = localStorage.getItem(ADMIN_KEY_STORAGE)
      if (s) return s
    } catch (_) {}
    const env = import.meta.env.VITE_AGENT_ADMIN_KEY
    return typeof env === 'string' ? env : ''
  })
  const [devices, setDevices] = useState<DeviceRow[]>([])
  const [loadingList, setLoadingList] = useState(false)
  const [pairBusy, setPairBusy] = useState(false)
  const [lastCode, setLastCode] = useState<{ code: string; expires_unix: number } | null>(null)
  const [selectedDeviceId, setSelectedDeviceId] = useState('')
  const [accountId, setAccountId] = useState('exness')
  const [symbol, setSymbol] = useState('EURUSDm')
  const [orderType, setOrderType] = useState<'buy' | 'sell'>('buy')
  const [volume, setVolume] = useState(0.01)
  const [orderComment, setOrderComment] = useState('panel-remote')
  const [enqueueBusy, setEnqueueBusy] = useState(false)
  const [workerEnabled, setWorkerEnabled] = useState(false)
  const [workerAccounts, setWorkerAccounts] = useState('default,exness')
  const [workerSymbols, setWorkerSymbols] = useState('EURUSDm,XAUUSDm')
  const [workerMinVol, setWorkerMinVol] = useState(0.01)
  const [workerMaxVol, setWorkerMaxVol] = useState(0.1)
  const [workerMinInt, setWorkerMinInt] = useState(5)
  const [workerMaxInt, setWorkerMaxInt] = useState(10)
  const [workerMaxOpen, setWorkerMaxOpen] = useState(0)
  const [workerBusy, setWorkerBusy] = useState(false)
  const [commands, setCommands] = useState<CommandRow[]>([])
  const [loadingCommands, setLoadingCommands] = useState(false)
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [hubLive, setHubLive] = useState(false)
  const [serverKeyInfo, setServerKeyInfo] = useState<{
    persisted: boolean
    using_dev_default: boolean
  } | null>(null)
  const [newServerKey, setNewServerKey] = useState('')
  const [saveServerKeyBusy, setSaveServerKeyBusy] = useState(false)

  useEffect(() => {
    try {
      if (adminKey) localStorage.setItem(ADMIN_KEY_STORAGE, adminKey)
    } catch (_) {}
  }, [adminKey])

  const refreshServerKeyInfo = useCallback(async () => {
    try {
      const r = await apiFetch(`${API}/agent/admin-key/status`)
      const d = await r.json().catch(() => ({}))
      if (r.ok && d.ok) {
        setServerKeyInfo({
          persisted: !!d.persisted,
          using_dev_default: !!d.using_dev_default,
        })
      } else {
        setServerKeyInfo(null)
      }
    } catch {
      setServerKeyInfo(null)
    }
  }, [])

  useEffect(() => {
    void refreshServerKeyInfo()
  }, [refreshServerKeyInfo])

  const saveServerAdminKey = async () => {
    const nk = newServerKey.trim()
    if (nk.length < 8) {
      setMsg({ type: 'error', text: 'New server key must be at least 8 characters.' })
      return
    }
    if (!adminKey.trim()) {
      setMsg({ type: 'error', text: 'Enter the current admin key above (must match the server).' })
      return
    }
    setSaveServerKeyBusy(true)
    setMsg(null)
    try {
      const r = await apiFetch(`${API}/agent/admin-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_key: adminKey, new_key: nk }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok || !data.ok) {
        setMsg({ type: 'error', text: data.error || `HTTP ${r.status}` })
        return
      }
      setAdminKey(nk)
      setNewServerKey('')
      setMsg({
        type: 'success',
        text: 'Server admin key saved (backend/data/agent_admin_key.txt). This browser key was updated to match.',
      })
      void refreshServerKeyInfo()
    } catch {
      setMsg({ type: 'error', text: 'Request failed' })
    } finally {
      setSaveServerKeyBusy(false)
    }
  }

  const refreshDevices = useCallback(async () => {
    if (!adminKey.trim()) {
      setMsg({ type: 'error', text: 'Enter admin key (same as server AGENT_ADMIN_KEY).' })
      return
    }
    setLoadingList(true)
    setMsg(null)
    try {
      const r = await apiFetch(`${API}/agent/devices/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_key: adminKey }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok || !data.ok) {
        setMsg({ type: 'error', text: data.error || `HTTP ${r.status}` })
        setDevices([])
        return
      }
      const list = Array.isArray(data.devices) ? (data.devices as DeviceRow[]) : []
      setDevices(list)
      setSelectedDeviceId((prev) => {
        if (list.length === 0) return ''
        if (prev && list.some((d) => d.device_id === prev)) return prev
        return list[0].device_id
      })
    } catch {
      setMsg({ type: 'error', text: 'Could not reach API. Is the backend running?' })
      setDevices([])
    } finally {
      setLoadingList(false)
    }
  }, [adminKey])

  const refreshCommands = useCallback(async () => {
    if (!adminKey.trim()) return
    setLoadingCommands(true)
    try {
      const r = await apiFetch(`${API}/agent/commands/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_key: adminKey, device_id: selectedDeviceId || undefined, limit: 20 }),
      })
      const data = await r.json().catch(() => ({}))
      if (r.ok && data.ok && Array.isArray(data.commands)) {
        setCommands(data.commands as CommandRow[])
      }
    } catch (_) {
      // keep last loaded commands
    } finally {
      setLoadingCommands(false)
    }
  }, [adminKey, selectedDeviceId])

  const refreshDevicesRef = useRef(refreshDevices)
  const refreshCommandsRef = useRef(refreshCommands)
  useEffect(() => {
    refreshDevicesRef.current = refreshDevices
    refreshCommandsRef.current = refreshCommands
  }, [refreshDevices, refreshCommands])

  useEffect(() => {
    refreshDevices()
    const id = window.setInterval(() => {
      if (!hubLive) void refreshDevices()
    }, 12000)
    return () => clearInterval(id)
  }, [refreshDevices, hubLive])

  useEffect(() => {
    refreshCommands()
    const id = window.setInterval(() => {
      if (!hubLive) void refreshCommands()
    }, 7000)
    return () => clearInterval(id)
  }, [refreshCommands, hubLive])

  useEffect(() => {
    if (!adminKey.trim()) {
      setHubLive(false)
      return
    }
    let cancelled = false
    let socket: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined

    const fullRefresh = () => {
      void refreshDevicesRef.current()
      void refreshCommandsRef.current()
    }

    const connect = () => {
      if (cancelled) return
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(appendPanelKeyToWsUrl(`${proto}//${window.location.host}/ws/agent`))
      socket.onopen = () => {
        setHubLive(true)
        socket?.send(JSON.stringify({ admin_key: adminKey }))
        fullRefresh()
      }
      socket.onmessage = (ev) => {
        try {
          const d = JSON.parse(String(ev.data)) as { type?: string }
          if (d?.type === 'refresh') fullRefresh()
        } catch (_) {
          /* ignore */
        }
      }
      socket.onclose = () => {
        setHubLive(false)
        if (cancelled) return
        reconnectTimer = window.setTimeout(connect, 4000)
      }
      socket.onerror = () => {
        socket?.close()
      }
    }

    connect()
    return () => {
      cancelled = true
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      setHubLive(false)
      socket?.close()
    }
  }, [adminKey])

  const loadWorkerConfig = useCallback(async () => {
    if (!adminKey.trim() || !selectedDeviceId) return
    try {
      const r = await apiFetch(`${API}/agent/worker/get`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_key: adminKey, device_id: selectedDeviceId }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok || !data.ok || !data.config) return
      const cfg = data.config
      setWorkerEnabled(!!cfg.enabled)
      setWorkerAccounts(Array.isArray(cfg.account_ids) ? cfg.account_ids.join(',') : 'default')
      setWorkerSymbols(Array.isArray(cfg.symbols) ? cfg.symbols.join(',') : '')
      setWorkerMinVol(Math.max(0.01, Number(cfg.min_volume) || 0.01))
      setWorkerMaxVol(Math.max(0.01, Number(cfg.max_volume) || 0.10))
      setWorkerMinInt(Math.max(0.5, Number(cfg.min_interval_minutes) || 5))
      setWorkerMaxInt(Math.max(0.5, Number(cfg.max_interval_minutes) || 10))
      setWorkerMaxOpen(Math.max(0, Number(cfg.max_open_positions) || 0))
    } catch (_) {
      // ignore
    }
  }, [adminKey, selectedDeviceId])

  useEffect(() => {
    loadWorkerConfig()
  }, [loadWorkerConfig])

  const createPairingCode = async () => {
    if (!adminKey.trim()) {
      setMsg({ type: 'error', text: 'Enter admin key first.' })
      return
    }
    setPairBusy(true)
    setMsg(null)
    try {
      const r = await apiFetch(`${API}/agent/pairing-codes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_key: adminKey }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok || !data.ok) {
        setMsg({ type: 'error', text: data.error || `HTTP ${r.status}` })
        return
      }
      setLastCode({ code: data.code, expires_unix: data.expires_unix })
      setMsg({ type: 'success', text: 'Give this code to the user running the desktop agent (PAIRING_CODE env). Valid about 10 minutes.' })
    } catch {
      setMsg({ type: 'error', text: 'Request failed' })
    } finally {
      setPairBusy(false)
    }
  }

  const enqueueOrder = async () => {
    if (!selectedDeviceId) {
      setMsg({ type: 'error', text: 'Select a device.' })
      return
    }
    if (!adminKey.trim()) {
      setMsg({ type: 'error', text: 'Enter admin key.' })
      return
    }
    setEnqueueBusy(true)
    setMsg(null)
    try {
      const r = await apiFetch(`${API}/agent/commands/enqueue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          admin_key: adminKey,
          device_id: selectedDeviceId,
          type: 'place_market_order',
          ttl_sec: 300,
          payload: {
            account_id: accountId.trim() || 'default',
            symbol: symbol.trim(),
            order_type: orderType,
            volume,
            comment: orderComment.trim() || 'panel-remote',
          },
        }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok || !data.ok) {
        setMsg({ type: 'error', text: data.error || `HTTP ${r.status}` })
        return
      }
      setMsg({
        type: 'success',
        text: `Queued command ${data.command_id}. The agent will execute when it polls (within a few seconds).`,
      })
    } catch {
      setMsg({ type: 'error', text: 'Request failed' })
    } finally {
      setEnqueueBusy(false)
    }
  }

  const saveWorkerConfig = async () => {
    if (!selectedDeviceId) {
      setMsg({ type: 'error', text: 'Select a device.' })
      return
    }
    setWorkerBusy(true)
    setMsg(null)
    try {
      const account_ids = workerAccounts
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const symbols = workerSymbols
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const r = await apiFetch(`${API}/agent/worker/set`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          admin_key: adminKey,
          device_id: selectedDeviceId,
          enabled: workerEnabled,
          account_ids,
          symbols,
          min_volume: workerMinVol,
          max_volume: workerMaxVol,
          min_interval_minutes: workerMinInt,
          max_interval_minutes: workerMaxInt,
          max_open_positions: workerMaxOpen,
        }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok || !data.ok) {
        setMsg({ type: 'error', text: data.error || `HTTP ${r.status}` })
        return
      }
      setMsg({ type: 'success', text: 'Worker config saved.' })
      refreshDevices()
      refreshCommands()
    } catch {
      setMsg({ type: 'error', text: 'Request failed' })
    } finally {
      setWorkerBusy(false)
    }
  }

  return (
    <div className="remote-agents-page">
      <div className="card trading-card">
        <div className="trading-card-header">
          <div>
            <h2>Remote devices</h2>
            <p className="muted" style={{ margin: '0.35rem 0 0' }}>
              Pair desktop agents and enqueue orders on PCs where MT5 runs. Use the admin key field below (or set the key
              on the server from this page — no <code className="remote-inline-code">.env</code> edit required).
            </p>
          </div>
          <span className="trading-badge subtle">Phase 2</span>
        </div>

        <div className="form-row" style={{ marginBottom: '1rem' }}>
          <label htmlFor="admin-key">Admin key</label>
          <input
            id="admin-key"
            type="password"
            autoComplete="off"
            placeholder="e.g. dev-admin-change-me"
            value={adminKey}
            onChange={(e) => setAdminKey(e.target.value)}
          />
          <p className="settings-hint" style={{ marginTop: '-0.35rem' }}>
            Stored in this browser (localStorage). It must match the server; you can change the key on the server in the
            section below without editing <code className="remote-inline-code">.env</code> (file overrides env:
            <code className="remote-inline-code"> backend/data/agent_admin_key.txt</code>).
          </p>
        </div>

        {serverKeyInfo && (
          <div
            className="form-row"
            style={{
              marginTop: '0.25rem',
              padding: '0.85rem',
              background: 'rgba(127, 127, 127, 0.08)',
              borderRadius: '6px',
            }}
          >
            <p className="settings-hint" style={{ margin: '0 0 0.6rem' }}>
              <strong>Server admin key:</strong>{' '}
              {serverKeyInfo.persisted
                ? 'persisted in backend/data/agent_admin_key.txt (overrides AGENT_ADMIN_KEY on restart).'
                : 'using AGENT_ADMIN_KEY env or dev default — not saved to disk yet.'}{' '}
              {serverKeyInfo.using_dev_default ? 'Still on dev default — set a strong key below for non-local use.' : ''}
            </p>
            <label htmlFor="new-server-admin-key">New admin key (min 8 characters, saved on server)</label>
            <input
              id="new-server-admin-key"
              type="password"
              autoComplete="new-password"
              value={newServerKey}
              onChange={(e) => setNewServerKey(e.target.value)}
              placeholder="e.g. long random secret"
            />
            <button
              type="button"
              style={{ marginTop: '0.55rem' }}
              disabled={saveServerKeyBusy}
              onClick={() => void saveServerAdminKey()}
            >
              {saveServerKeyBusy ? 'Saving…' : 'Save new key on server'}
            </button>
            <p className="settings-hint" style={{ marginTop: '0.45rem', marginBottom: 0 }}>
              Uses the <strong>Admin key</strong> field above as the current password. After a successful save, this
              browser field updates to the new key automatically.
            </p>
          </div>
        )}

        <div className="trading-section-divider" />

        <div className="remote-agents-toolbar">
          <button type="button" onClick={refreshDevices} disabled={loadingList}>
            {loadingList ? 'Refreshing…' : 'Refresh device list'}
          </button>
          <button type="button" onClick={createPairingCode} disabled={pairBusy}>
            {pairBusy ? 'Creating…' : 'New pairing code'}
          </button>
          <span className="muted" style={{ marginLeft: 'auto', fontSize: '0.85rem' }} title="WebSocket to /ws/agent">
            {hubLive ? 'Live updates' : adminKey.trim() ? 'Polling · reconnecting…' : 'Enter admin key'}
          </span>
        </div>

        {lastCode && (
          <div className="msg success remote-pair-banner">
            <strong>Pairing code:</strong>{' '}
            <span className="remote-pair-code">{lastCode.code}</span>
            <span className="muted" style={{ marginLeft: '0.5rem' }}>
              (expires Unix {lastCode.expires_unix})
            </span>
          </div>
        )}

        {msg && (
          <div className={`msg ${msg.type === 'success' ? 'success' : 'error'}`} style={{ marginTop: '0.75rem' }}>
            {msg.text}
          </div>
        )}

        <div className="table-wrap" style={{ marginTop: '1rem' }}>
          <table className="slave-table remote-devices-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Label</th>
                <th>Device ID</th>
                <th>MT5</th>
                <th>Agent</th>
                <th>Last heartbeat</th>
              </tr>
            </thead>
            <tbody>
              {devices.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    No devices yet. Create a pairing code and run the desktop agent on the remote PC.
                  </td>
                </tr>
              )}
              {devices.map((d) => (
                <tr key={d.device_id}>
                  <td>
                    <span className={d.probably_online ? 'remote-dot online' : 'remote-dot offline'} title={d.probably_online ? 'Recent heartbeat' : 'Offline or stale'} />
                    {d.probably_online ? 'Online' : 'Offline'}
                  </td>
                  <td>{d.label}</td>
                  <td>
                    <code className="remote-device-id">{d.device_id}</code>
                  </td>
                  <td>{d.last_mt5_connected ? 'OK' : '—'}</td>
                  <td>{d.last_agent_version || '—'}</td>
                  <td>{d.last_heartbeat_unix ? new Date(d.last_heartbeat_unix * 1000).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card trading-card" style={{ marginTop: '1rem' }}>
        <div className="trading-card-header">
          <h2>Enqueue market order</h2>
          <span className="trading-badge subtle">Remote PC</span>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          The remote agent must map <code className="remote-inline-code">account_id</code> to a terminal path in its{' '}
          <code className="remote-inline-code">config.json</code>.
        </p>

        <div className="trading-form-grid one-col" style={{ maxWidth: '420px' }}>
          <div className="form-row">
            <label htmlFor="remote-device">Target device</label>
            <select
              id="remote-device"
              value={selectedDeviceId}
              onChange={(e) => setSelectedDeviceId(e.target.value)}
            >
              {devices.length === 0 && <option value="">No devices — refresh list</option>}
              {devices.map((d) => (
                <option key={d.device_id} value={d.device_id}>
                  {d.label} {!d.probably_online ? '(offline)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label htmlFor="remote-account">Account id (agent config)</label>
            <input
              id="remote-account"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              placeholder="exness / default / clone:…"
            />
          </div>
          <div className="form-row">
            <label htmlFor="remote-symbol">Symbol</label>
            <input id="remote-symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} />
          </div>
          <div className="form-row">
            <label htmlFor="remote-side">Side</label>
            <select
              id="remote-side"
              value={orderType}
              onChange={(e) => setOrderType(e.target.value as 'buy' | 'sell')}
            >
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </select>
          </div>
          <div className="form-row">
            <label htmlFor="remote-vol">Volume (lots)</label>
            <input
              id="remote-vol"
              type="number"
              min={0.01}
              step={0.01}
              value={volume}
              onChange={(e) => setVolume(Math.max(0.01, Number(e.target.value) || 0.01))}
            />
          </div>
          <div className="form-row">
            <label htmlFor="remote-comment">Comment</label>
            <input id="remote-comment" value={orderComment} onChange={(e) => setOrderComment(e.target.value)} />
          </div>
        </div>

        <div className="trading-actions" style={{ marginTop: '0.75rem' }}>
          <button type="button" onClick={enqueueOrder} disabled={enqueueBusy || !selectedDeviceId}>
            {enqueueBusy ? 'Queueing…' : 'Enqueue order'}
          </button>
        </div>
      </div>

      <div className="card trading-card" style={{ marginTop: '1rem' }}>
        <div className="trading-card-header">
          <h2>Remote worker (Fixed Lot)</h2>
          <span className="trading-badge subtle">Server scheduled</span>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          Scheduler runs in backend and enqueues <code className="remote-inline-code">fixed_lot_tick</code> to this device.
        </p>
        <div className="trading-form-grid one-col" style={{ maxWidth: '520px' }}>
          <label className="trading-toggle">
            <input type="checkbox" checked={workerEnabled} onChange={(e) => setWorkerEnabled(e.target.checked)} />
            Enable remote worker
          </label>
          <div className="form-row">
            <label>Accounts (comma separated)</label>
            <input value={workerAccounts} onChange={(e) => setWorkerAccounts(e.target.value)} />
          </div>
          <div className="form-row">
            <label>Symbols (comma separated)</label>
            <input value={workerSymbols} onChange={(e) => setWorkerSymbols(e.target.value)} />
          </div>
          <div className="form-row-inline">
            <div className="form-row">
              <label>Min volume</label>
              <input type="number" min={0.01} step={0.01} value={workerMinVol} onChange={(e) => setWorkerMinVol(Math.max(0.01, Number(e.target.value) || 0.01))} />
            </div>
            <div className="form-row">
              <label>Max volume</label>
              <input type="number" min={0.01} step={0.01} value={workerMaxVol} onChange={(e) => setWorkerMaxVol(Math.max(0.01, Number(e.target.value) || 0.01))} />
            </div>
          </div>
          <div className="form-row-inline">
            <div className="form-row">
              <label>Min interval (min)</label>
              <input type="number" min={0.5} step={0.5} value={workerMinInt} onChange={(e) => setWorkerMinInt(Math.max(0.5, Number(e.target.value) || 0.5))} />
            </div>
            <div className="form-row">
              <label>Max interval (min)</label>
              <input type="number" min={0.5} step={0.5} value={workerMaxInt} onChange={(e) => setWorkerMaxInt(Math.max(0.5, Number(e.target.value) || 0.5))} />
            </div>
          </div>
          <div className="form-row">
            <label>Max open positions per account (0 = no cap)</label>
            <input type="number" min={0} step={1} value={workerMaxOpen} onChange={(e) => setWorkerMaxOpen(Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
          </div>
        </div>
        <div className="trading-actions">
          <button type="button" onClick={saveWorkerConfig} disabled={workerBusy || !selectedDeviceId}>
            {workerBusy ? 'Saving…' : 'Save worker config'}
          </button>
        </div>
      </div>

      <div className="card trading-card" style={{ marginTop: '1rem' }}>
        <div className="trading-card-header">
          <h2>Recent command history</h2>
          <span className="trading-badge subtle">{loadingCommands ? 'Refreshing…' : `${commands.length} rows`}</span>
        </div>
        <div className="table-wrap">
          <table className="slave-table remote-devices-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>Status</th>
                <th>Device</th>
              </tr>
            </thead>
            <tbody>
              {commands.length === 0 && (
                <tr><td colSpan={4} className="muted">No commands yet.</td></tr>
              )}
              {commands.map((c) => (
                <tr key={c.id}>
                  <td>{c.created_unix ? new Date(c.created_unix * 1000).toLocaleString() : '—'}</td>
                  <td>{c.type || c.cmd_type || '—'}</td>
                  <td>{c.status}</td>
                  <td><code className="remote-device-id">{c.device_id}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
