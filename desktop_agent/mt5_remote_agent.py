"""
MT5 Remote Agent (Phase 2) — runs on the PC where MetaTrader 5 is installed.

- Registers with the hub using a one-time pairing code (or uses saved device_id + token).
- Sends heartbeats and polls for remote commands.
- Executes:
  - place_market_order
  - fixed_lot_tick (server-scheduled worker tick)
"""

from __future__ import annotations

import json
import os
import random
import shutil
import subprocess
import sys
import traceback
import threading
from pathlib import Path
from typing import Any

import requests

CONFIG_NAME = "config.json"


def agent_dir() -> Path:
    """Directory containing config.json and (when packaged) python_bridge/."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def resolve_bridge_path(cfg: dict[str, Any]) -> Path:
    raw = (cfg.get("bridge_script") or "").strip()
    if not raw:
        return Path()
    p = Path(raw)
    if not p.is_absolute():
        p = agent_dir() / p
    return p.resolve()


def python_invocation(cfg: dict[str, Any]) -> list[str]:
    """Argv prefix to run the bridge script: either ['py', '-3'] or ['C:\\...\\python.exe']."""
    raw = (cfg.get("python_exe") or "py").strip() or "py"
    lower = raw.lower()
    if lower == "py":
        return ["py", "-3"]
    if lower in ("python", "python3"):
        return [raw]
    p = Path(raw)
    if not p.is_absolute():
        p = (agent_dir() / p).resolve()
    else:
        p = p.resolve()
    if p.is_dir():
        p = p / "python.exe"
    if p.name.lower() == "py.exe":
        return [str(p), "-3"]
    return [str(p)]


def load_config(path: Path) -> dict[str, Any]:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_config(path: Path, cfg: dict[str, Any]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")


def config_path() -> Path:
    return agent_dir() / CONFIG_NAME


def pause_if_frozen_exe() -> None:
    """When run as PyInstaller .exe, keep the console open so error text can be read."""
    if not getattr(sys, "frozen", False) or os.name != "nt":
        return
    try:
        input("\nPress Enter to exit...")
    except (EOFError, KeyboardInterrupt):
        pass


def exit_fail(msg: str) -> None:
    print(msg, flush=True)
    pause_if_frozen_exe()
    sys.exit(1)


def hub_headers(cfg: dict[str, Any]) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {cfg['token']}",
        "X-Device-Id": cfg["device_id"],
        "Content-Type": "application/json",
    }


def register_pairing(api_base: str, code: str, label: str) -> tuple[str, str]:
    r = requests.post(
        f"{api_base.rstrip('/')}/api/agent/register",
        json={"code": code, "label": label},
        timeout=30,
    )
    r.raise_for_status()
    data = r.json()
    if not data.get("ok"):
        raise RuntimeError(data.get("error", "register failed"))
    return data["device_id"], data["token"]


def bridge_call(cfg: dict[str, Any], action: str, body: dict[str, Any], terminal_path: str) -> dict[str, Any]:
    bridge = resolve_bridge_path(cfg)
    if not bridge.is_file():
        return {"ok": False, "message": f"bridge_script not found: {bridge}"}
    env = os.environ.copy()
    env["MT5_TERMINAL_PATH"] = terminal_path
    cwd = str(bridge.parent)
    proc = subprocess.run(
        python_invocation(cfg) + [str(bridge), action],
        input=json.dumps(body),
        text=True,
        capture_output=True,
        timeout=60,
        env=env,
        cwd=cwd,
    )
    raw = (proc.stdout or "").strip() or (proc.stderr or "").strip()
    if proc.returncode != 0:
        return {"ok": False, "message": raw or f"bridge exit {proc.returncode}"}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"ok": False, "message": raw}


def mt5_quick_check(cfg: dict[str, Any]) -> bool:
    bridge = resolve_bridge_path(cfg)
    if not bridge.is_file():
        return False
    accounts: dict[str, str] = cfg.get("accounts") or {}
    for term_path in accounts.values():
        if not term_path:
            continue
        out = bridge_call(cfg, "symbols", {}, term_path)
        if out.get("ok"):
            return True
    return False


def run_create_position(cfg: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    account_id = (payload.get("account_id") or "default").strip()
    accounts: dict[str, str] = cfg.get("accounts") or {}
    term_path = accounts.get(account_id)
    if not term_path:
        return {"ok": False, "message": f"unknown account_id '{account_id}' in agent config"}
    body = {
        "symbol": payload.get("symbol") or "",
        "order_type": (payload.get("order_type") or "buy").lower(),
        "volume": float(payload.get("volume") or 0.01),
        "comment": (payload.get("comment") or "remote-agent").strip(),
    }
    return bridge_call(cfg, "create_position", body, term_path)


def run_fixed_lot_tick(cfg: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    accounts_map: dict[str, str] = cfg.get("accounts") or {}
    account_ids = payload.get("account_ids")
    if not isinstance(account_ids, list) or not account_ids:
        account_ids = ["default"]
    symbol = str(payload.get("symbol") or "").strip()
    order_type = str(payload.get("order_type") or "buy").strip().lower()
    volume = float(payload.get("volume") or 0.01)
    comment = str(payload.get("comment") or "remote-fixedlot")
    max_open_positions = int(payload.get("max_open_positions") or 0)

    lines: list[str] = []
    any_ok = False
    for account_id in account_ids:
        aid = str(account_id).strip()
        term_path = accounts_map.get(aid)
        if not term_path:
            lines.append(f"{aid}: not configured")
            continue
        if max_open_positions > 0:
            p = bridge_call(cfg, "positions", {}, term_path)
            if p.get("ok"):
                pos = p.get("positions")
                if isinstance(pos, list) and len(pos) >= max_open_positions:
                    lines.append(f"{aid}: skipped (max open {max_open_positions})")
                    continue
        out = bridge_call(
            cfg,
            "create_position",
            {
                "symbol": symbol,
                "order_type": order_type,
                "volume": volume,
                "comment": comment,
            },
            term_path,
        )
        if out.get("ok"):
            any_ok = True
            lines.append(f"{aid}: ok")
        else:
            lines.append(f"{aid}: {out.get('message') or out.get('error') or 'failed'}")
    return {"ok": any_ok, "message": " | ".join(lines), "results": lines}


def heartbeat_loop(cfg: dict[str, Any], stop: threading.Event) -> None:
    base = cfg["api_base"].rstrip("/")
    interval = float(cfg.get("heartbeat_interval_sec") or 15)
    while not stop.wait(timeout=interval):
        try:
            mt5_ok = mt5_quick_check(cfg)
            r = requests.post(
                f"{base}/api/agent/heartbeat",
                headers=hub_headers(cfg),
                json={
                    "agent_version": cfg.get("agent_version") or "0.2.0",
                    "mt5_connected": mt5_ok,
                },
                timeout=20,
            )
            if r.status_code >= 400:
                print("[heartbeat]", r.status_code, r.text[:200])
        except requests.RequestException as e:
            print("[heartbeat] error:", e)


def post_complete(base: str, cfg: dict[str, Any], command_id: str, ok: bool, result: dict[str, Any]) -> None:
    try:
        requests.post(
            f"{base}/api/agent/commands/complete",
            headers=hub_headers(cfg),
            json={"command_id": command_id, "ok": ok, "result": result},
            timeout=30,
        )
    except requests.RequestException as e:
        print("[complete] error:", e)


def ensure_config_file(path: Path) -> None:
    """Create config.json from config.example.json next to the exe if missing."""
    if path.is_file():
        return
    ex = agent_dir() / "config.example.json"
    if ex.is_file():
        shutil.copy(ex, path)
        return
    exit_fail(
        f"Missing config file:\n  {path}\n\n"
        "Copy config.example.json to config.json next to this program."
    )


def run_windows_pairing_ui(path: Path) -> None:
    """Tk pairing wizard (Windows + PyInstaller). Blocks until window closed; starts agent threads after success."""
    import tkinter as tk
    from tkinter import ttk

    cfg = load_config(path)
    stop = threading.Event()
    paired = False

    root = tk.Tk()
    root.title("MT5 Remote Agent — pair this PC")
    root.minsize(460, 320)
    root.resizable(True, False)

    main = ttk.Frame(root, padding=14)
    main.pack(fill=tk.BOTH, expand=True)

    ttk.Label(
        main,
        text="Enter the pairing code from the panel (Remote devices → New pairing code), then register.",
        wraplength=420,
    ).pack(anchor=tk.W)

    row1 = ttk.Frame(main)
    row1.pack(fill=tk.X, pady=(10, 4))
    ttk.Label(row1, text="Panel API URL", width=18).pack(side=tk.LEFT)
    api_var = tk.StringVar(value=str(cfg.get("api_base") or "http://127.0.0.1:3001"))
    ttk.Entry(row1, textvariable=api_var).pack(side=tk.LEFT, fill=tk.X, expand=True)

    row2 = ttk.Frame(main)
    row2.pack(fill=tk.X, pady=4)
    ttk.Label(row2, text="Pairing code", width=18).pack(side=tk.LEFT)
    code_var = tk.StringVar()
    ttk.Entry(row2, textvariable=code_var).pack(side=tk.LEFT, fill=tk.X, expand=True)

    row3 = ttk.Frame(main)
    row3.pack(fill=tk.X, pady=4)
    ttk.Label(row3, text="Device label (optional)", width=18).pack(side=tk.LEFT)
    label_var = tk.StringVar(value=os.environ.get("DEVICE_LABEL", f"agent-{random.randint(1000, 9999)}"))
    ttk.Entry(row3, textvariable=label_var).pack(side=tk.LEFT, fill=tk.X, expand=True)

    err_var = tk.StringVar()
    err_lbl = ttk.Label(main, textvariable=err_var, foreground="#b00020", wraplength=420)
    err_lbl.pack(anchor=tk.W, pady=(8, 0))

    def show_running_state() -> None:
        nonlocal paired
        paired = True
        c = load_config(path)
        threading.Thread(target=heartbeat_loop, args=(c, stop), daemon=True).start()
        threading.Thread(target=poll_loop, args=(c, stop), daemon=True).start()
        for w in main.winfo_children():
            w.destroy()
        ttk.Label(main, text="Connected to the panel", font=("Segoe UI", 12, "bold")).pack(anchor=tk.W, pady=(0, 8))
        ttk.Label(
            main,
            text="The agent is running in the background. Minimize this window.\nClose it when you want to stop the agent.",
            wraplength=420,
        ).pack(anchor=tk.W)
        ttk.Label(main, text=str(path), font=("Consolas", 8)).pack(anchor=tk.W, pady=(12, 0))

        def on_running_close() -> None:
            stop.set()
            root.destroy()

        root.protocol("WM_DELETE_WINDOW", on_running_close)

    def do_register() -> None:
        err_var.set("")
        api = api_var.get().strip()
        code = code_var.get().strip()
        label = (label_var.get().strip() or f"agent-{random.randint(1000, 9999)}")
        if not api or not code:
            err_var.set("Panel URL and pairing code are required.")
            return
        try:
            did, tok = register_pairing(api, code, label)
        except requests.RequestException as e:
            err_var.set(f"Network / server error: {e}")
            return
        except (RuntimeError, ValueError, KeyError) as e:
            err_var.set(str(e))
            return
        cfg["api_base"] = api
        cfg["device_id"] = did
        cfg["token"] = tok
        save_config(path, cfg)
        show_running_state()

    btn_row = ttk.Frame(main)
    btn_row.pack(fill=tk.X, pady=(14, 0))
    ttk.Button(btn_row, text="Register with panel", command=do_register).pack(side=tk.LEFT)

    hint = ttk.Label(
        main,
        text="Tip: set MT5 terminal paths in config.json (accounts) if the defaults do not match this PC.",
        wraplength=420,
        font=("Segoe UI", 9),
    )
    hint.pack(anchor=tk.W, pady=(12, 0))

    def on_early_close() -> None:
        root.destroy()
        if not paired:
            sys.exit(1)

    root.protocol("WM_DELETE_WINDOW", on_early_close)
    root.mainloop()
    if not paired:
        sys.exit(1)


def poll_loop(cfg: dict[str, Any], stop: threading.Event) -> None:
    base = cfg["api_base"].rstrip("/")
    interval = float(cfg.get("poll_interval_sec") or 2)
    while not stop.is_set():
        try:
            r = requests.get(
                f"{base}/api/agent/commands/next",
                headers=hub_headers(cfg),
                timeout=30,
            )
            data = r.json()
            if not data.get("ok"):
                print("[poll]", r.status_code, data)
                stop.wait(interval)
                continue
            cmd = data.get("command")
            if not cmd:
                stop.wait(interval)
                continue
            cid = cmd["id"]
            ctype = cmd.get("type") or cmd.get("cmd_type")
            payload = cmd.get("payload") if isinstance(cmd.get("payload"), dict) else {}
            if ctype == "place_market_order":
                result = run_create_position(cfg, payload)
                post_complete(base, cfg, cid, bool(result.get("ok")), result)
            elif ctype == "fixed_lot_tick":
                result = run_fixed_lot_tick(cfg, payload)
                post_complete(base, cfg, cid, bool(result.get("ok")), result)
            else:
                post_complete(
                    base,
                    cfg,
                    cid,
                    False,
                    {"ok": False, "message": f"unsupported type: {ctype}"},
                )
        except requests.RequestException as e:
            print("[poll] error:", e)
        stop.wait(interval)


def main() -> None:
    print("MT5 Remote Agent starting...", flush=True)
    path = config_path()
    ensure_config_file(path)
    cfg = load_config(path)
    api_base = cfg.get("api_base") or "http://127.0.0.1:3001"

    use_gui_pairing = (
        getattr(sys, "frozen", False)
        and os.name == "nt"
        and not os.environ.get("MT5_AGENT_NO_GUI")
        and not os.environ.get("PAIRING_CODE", "").strip()
        and (not (cfg.get("device_id") or "").strip() or not (cfg.get("token") or "").strip())
    )

    pairing = os.environ.get("PAIRING_CODE", "").strip()
    if pairing and (not cfg.get("device_id") or not cfg.get("token")):
        label = os.environ.get("DEVICE_LABEL", f"agent-{random.randint(1000, 9999)}")
        try:
            did, tok = register_pairing(api_base, pairing, label)
        except requests.RequestException as e:
            exit_fail(f"Pairing request failed (check api_base URL and network):\n{e}")
        except (RuntimeError, ValueError, KeyError) as e:
            exit_fail(f"Pairing failed:\n{e}")
        cfg["device_id"] = did
        cfg["token"] = tok
        save_config(path, cfg)
        print("Registered device. Saved device_id and token to", path)

    if not cfg.get("device_id") or not cfg.get("token"):
        if use_gui_pairing:
            print("Opening pairing window…", flush=True)
            run_windows_pairing_ui(path)
            return
        exit_fail(
            "This device is not registered yet.\n\n"
            "Windows app: run MT5RemoteAgent.exe — a pairing window should open.\n"
            "Or set PAIRING_CODE in the environment, or paste device_id and token into config.json."
        )

    stop = threading.Event()
    t_hb = threading.Thread(target=heartbeat_loop, args=(cfg, stop), daemon=True)
    t_hb.start()
    try:
        poll_loop(cfg, stop)
    except KeyboardInterrupt:
        stop.set()
        print("Stopped.")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        pause_if_frozen_exe()
        sys.exit(1)
