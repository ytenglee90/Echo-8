from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from connector.novelforge_connector import (
    MAX_LOG_BYTES,
    _append_log,
    _build_child_command,
    _load_config,
)


class NovelForgeConnectorTests(unittest.TestCase):
    def test_config_keeps_pairing_secret_out_of_child_command_and_status_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            token = "A" * 43
            token_file = root / "pairing.token"
            token_file.write_text(token, encoding="ascii")
            config_file = root / "config.json"
            config_file.write_text(json.dumps({
                "version": 1,
                "engineRoot": str(root / "engine"),
                "canvasOrigins": ["https://canvas.example"],
                "port": 32147,
                "tokenFile": str(token_file),
                "statusFile": str(root / "status.json"),
                "logFile": str(root / "connector.log"),
            }), encoding="utf-8")
            config = _load_config(config_file)
            command = _build_child_command(config)
            self.assertIn("--pairing-token-file", command)
            self.assertNotIn(token, command)
            self.assertEqual(config.canvas_origins, ("https://canvas.example",))

    def test_rejects_non_origin_and_invalid_pairing_token(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            token_file = root / "pairing.token"
            token_file.write_text("short", encoding="ascii")
            config_file = root / "config.json"
            base = {
                "version": 1,
                "engineRoot": str(root / "engine"),
                "canvasOrigins": ["https://canvas.example/path"],
                "port": 32147,
                "tokenFile": str(token_file),
                "statusFile": str(root / "status.json"),
                "logFile": str(root / "connector.log"),
            }
            config_file.write_text(json.dumps(base), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, r"HTTP\(S\) origin"):
                _load_config(config_file)
            base["canvasOrigins"] = ["https://canvas.example"]
            config_file.write_text(json.dumps(base), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "pairing token"):
                _load_config(config_file)

    def test_log_rotation_is_bounded_and_recoverable(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            token_file = root / "pairing.token"
            token_file.write_text("A" * 43, encoding="ascii")
            config_file = root / "config.json"
            config_file.write_text(json.dumps({
                "version": 1,
                "engineRoot": str(root / "engine"),
                "canvasOrigins": ["http://localhost:3000"],
                "port": 32147,
                "tokenFile": str(token_file),
                "statusFile": str(root / "status.json"),
                "logFile": str(root / "connector.log"),
            }), encoding="utf-8")
            config = _load_config(config_file)
            config.log_file.write_bytes(b"x" * (MAX_LOG_BYTES + 1))
            _append_log(config, "restarted")
            self.assertLess(config.log_file.stat().st_size, 10_000)
            self.assertTrue(config.log_file.with_suffix(".log.1").is_file())


if __name__ == "__main__":
    unittest.main()
