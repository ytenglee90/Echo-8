from __future__ import annotations

import argparse
import ctypes
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


MUTEX_NAME = "Local\\NovelForgeCanvasConnectorV1"
CONFIG_VERSION = 1
RESTART_MIN_SECONDS = 5
RESTART_MAX_SECONDS = 60
MAX_LOG_BYTES = 2 * 1024 * 1024
TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_-]{43,256}\Z")


@dataclass(frozen=True)
class ConnectorConfig:
    engine_root: Path
    canvas_origins: tuple[str, ...]
    port: int
    token_file: Path
    status_file: Path
    log_file: Path


def _load_config(path: Path) -> ConnectorConfig:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("version") != CONFIG_VERSION:
        raise ValueError("unsupported NovelForge connector configuration")
    engine_root = _absolute_path(value.get("engineRoot"), "engineRoot")
    token_file = _absolute_path(value.get("tokenFile"), "tokenFile")
    status_file = _absolute_path(value.get("statusFile"), "statusFile")
    log_file = _absolute_path(value.get("logFile"), "logFile")
    origins = value.get("canvasOrigins")
    if not isinstance(origins, list) or not origins or any(
        not isinstance(origin, str) or not _is_http_origin(origin) for origin in origins
    ):
        raise ValueError("canvasOrigins must contain at least one HTTP(S) origin")
    port = value.get("port")
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        raise ValueError("port must be between 1 and 65535")
    if not token_file.is_file():
        raise ValueError("pairing token file is missing")
    if TOKEN_PATTERN.fullmatch(token_file.read_text(encoding="ascii").strip()) is None:
        raise ValueError("pairing token file is invalid")
    return ConnectorConfig(
        engine_root=engine_root,
        canvas_origins=tuple(dict.fromkeys(origins)),
        port=port,
        token_file=token_file,
        status_file=status_file,
        log_file=log_file,
    )


def _absolute_path(value: Any, label: str) -> Path:
    if not isinstance(value, str):
        raise ValueError(f"{label} must be an absolute path")
    path = Path(value)
    if not path.is_absolute() or path.parent == path:
        raise ValueError(f"{label} must be an absolute non-root path")
    return path.resolve()


def _is_http_origin(value: str) -> bool:
    parsed = urlsplit(value)
    return (
        parsed.scheme in {"http", "https"}
        and bool(parsed.hostname)
        and parsed.username is None
        and parsed.password is None
        and parsed.path in {"", "/"}
        and not parsed.query
        and not parsed.fragment
        and value.rstrip("/") == f"{parsed.scheme}://{parsed.netloc}"
    )


def _build_child_command(config: ConnectorConfig) -> list[str]:
    command = [
        sys.executable,
        "-B",
        "-m",
        "engine.novelforge.canvas_bridge_launcher",
        "--workspace",
        str(config.engine_root),
        "--port",
        str(config.port),
        "--pairing-token-file",
        str(config.token_file),
        "--defer-codex",
        "--quiet",
    ]
    for origin in config.canvas_origins:
        command.extend(["--origin", origin])
    return command


def _write_status(config: ConnectorConfig, state: str, child_pid: int | None = None, detail: str | None = None) -> None:
    config.status_file.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": CONFIG_VERSION,
        "state": state,
        "connectorPid": os.getpid(),
        "childPid": child_pid,
        "port": config.port,
        "canvasOrigins": list(config.canvas_origins),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        **({"detail": detail[:1000]} if detail else {}),
    }
    temporary = config.status_file.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(temporary, config.status_file)


def _append_log(config: ConnectorConfig, message: str) -> None:
    config.log_file.parent.mkdir(parents=True, exist_ok=True)
    _rotate_log(config.log_file)
    timestamp = datetime.now(timezone.utc).isoformat()
    with config.log_file.open("a", encoding="utf-8") as stream:
        stream.write(f"{timestamp} {message[:4000]}\n")


def _rotate_log(path: Path) -> None:
    if not path.is_file() or path.stat().st_size <= MAX_LOG_BYTES:
        return
    archived = path.with_suffix(path.suffix + ".1")
    if archived.exists():
        archived.unlink()
    path.replace(archived)


def _windows_single_instance() -> Any:
    if os.name != "nt":
        return None
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.CreateMutexW(None, False, MUTEX_NAME)
    if not handle:
        raise OSError("could not create connector mutex")
    if kernel32.GetLastError() == 183:
        kernel32.CloseHandle(handle)
        raise SystemExit(0)
    return handle


def run(config_path: Path, stop_event: threading.Event | None = None) -> int:
    config = _load_config(config_path)
    event = stop_event or threading.Event()
    mutex = _windows_single_instance()
    child: subprocess.Popen[bytes] | None = None

    def stop(*_args: Any) -> None:
        event.set()

    signal.signal(signal.SIGINT, stop)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, stop)
    delay = RESTART_MIN_SECONDS
    try:
        while not event.is_set():
            started = time.monotonic()
            try:
                environment = dict(os.environ)
                existing_path = environment.get("PYTHONPATH", "")
                environment["PYTHONPATH"] = str(config.engine_root) + (os.pathsep + existing_path if existing_path else "")
                creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
                config.log_file.parent.mkdir(parents=True, exist_ok=True)
                _rotate_log(config.log_file)
                with config.log_file.open("ab") as log_stream:
                    child = subprocess.Popen(
                        _build_child_command(config),
                        cwd=config.engine_root,
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL,
                        stderr=log_stream,
                        env=environment,
                        creationflags=creation_flags,
                    )
                    _write_status(config, "RUNNING", child.pid)
                    while child.poll() is None and not event.wait(1):
                        continue
                if event.is_set():
                    break
                exit_code = child.returncode
                _write_status(config, "RESTARTING", detail=f"bridge exited with code {exit_code}")
                _append_log(config, f"bridge exited with code {exit_code}; retrying in {delay}s")
            except Exception as exc:
                _write_status(config, "RESTARTING", detail=f"{type(exc).__name__}: {exc}")
                _append_log(config, f"connector launch failed: {type(exc).__name__}: {exc}")
            finally:
                child = None
            if time.monotonic() - started >= 30:
                delay = RESTART_MIN_SECONDS
            if event.wait(delay):
                break
            delay = min(RESTART_MAX_SECONDS, delay * 2)
        return 0
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
        _write_status(config, "STOPPED")
        if mutex is not None:
            ctypes.windll.kernel32.CloseHandle(mutex)


def main() -> None:
    parser = argparse.ArgumentParser(description="NovelForge Canvas Windows connector supervisor")
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    raise SystemExit(run(Path(args.config).resolve()))


if __name__ == "__main__":
    main()
