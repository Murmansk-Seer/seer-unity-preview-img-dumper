"""Select preview panels using the game's published display window."""

from __future__ import annotations

import json
import hashlib
import time
from pathlib import Path
if __package__:
    from .preview_window_dll import parse_file
else:
    from preview_window_dll import parse_file

WINDOW_NODE = "imgPreview"
DEFAULT_NODE = "imgPreview_1"


def manifest_version(path: Path) -> str:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    return str(manifest["version"])


def read_window(
    dll_path: Path, ui_path: Path, manifest_path: Path
) -> dict[str, int | str]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assets = manifest.get("items", {})
    required = (
        "DefaultPackage/game_dll_gamelogic_dll_bytes",
        "DefaultPackage/game_ui_activitylistpreview",
    )
    if any(name not in assets for name in required):
        raise ValueError("Local manifest does not contain both official preview assets")
    for name, path in zip(required, (dll_path, ui_path), strict=True):
        expected = str(assets[name]["fileHash"])
        if hashlib.md5(path.read_bytes()).hexdigest() != expected.lower():
            raise ValueError(f"Local {name} differs from the official manifest")
    start, end = parse_file(dll_path)
    return {
        "manifest_version": str(manifest["version"]),
        "start_ts": int(start.timestamp()),
        "end_ts": int(end.timestamp()),
    }


def select_panels(
    active_by_name: dict[str, bool], window: dict, *, now: float | None = None
) -> tuple[str, ...]:
    if not active_by_name:
        raise ValueError("No preview panels were found in the asset bundle")

    when = time.time() if now is None else now
    if window["start_ts"] <= when < window["end_ts"]:
        if WINDOW_NODE not in active_by_name or DEFAULT_NODE not in active_by_name:
            raise ValueError("Scheduled preview requires both image panels")
        return WINDOW_NODE, DEFAULT_NODE
    if DEFAULT_NODE not in active_by_name:
        raise ValueError("Default preview panel is missing")
    return (DEFAULT_NODE,)
