import json
import hashlib
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from parser import MergeImg
from parser.preview_selection import manifest_version, read_window, select_panels


WINDOW = {
    "ok": True,
    "manifest_version": "12345",
    "window_node": "imgPreview",
    "default_node": "imgPreview_1",
    "start_ts": 100,
    "end_ts": 200,
}
PANELS = {"imgPreview": False, "imgPreview_1": True}


class PreviewSelectionTests(unittest.TestCase):
    def test_manifest_version(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            path.write_text('{"version": "12345"}', encoding="utf-8")
            self.assertEqual(manifest_version(path), "12345")

    def test_window_starts_inclusive_and_ends_exclusive(self):
        self.assertEqual(
            select_panels(PANELS, WINDOW, now=100),
            ("imgPreview", "imgPreview_1"),
        )
        self.assertEqual(
            select_panels(PANELS, WINDOW, now=199),
            ("imgPreview", "imgPreview_1"),
        )
        self.assertEqual(select_panels(PANELS, WINDOW, now=200), ("imgPreview_1",))

    def test_window_outside_uses_default_panel(self):
        self.assertEqual(select_panels(PANELS, WINDOW, now=200), ("imgPreview_1",))

    def test_missing_window_panel_fails_closed(self):
        with self.assertRaises(ValueError):
            select_panels({"imgPreview_1": True}, WINDOW, now=150)

    def test_no_panels_fails(self):
        with self.assertRaises(ValueError):
            select_panels({}, WINDOW, now=150)

    def test_window_uses_local_dll_and_manifest(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / "manifest.json"
            dll = root / "game.dll"
            ui = root / "preview.bundle"
            dll.write_bytes(b"sample")
            ui.write_bytes(b"picture")
            manifest.write_text(json.dumps({
                "version": "12345",
                "items": {
                    "DefaultPackage/game_dll_gamelogic_dll_bytes": {
                        "fileHash": hashlib.md5(b"sample").hexdigest(),
                    },
                    "DefaultPackage/game_ui_activitylistpreview": {
                        "fileHash": hashlib.md5(b"picture").hexdigest(),
                    },
                },
            }), encoding="utf-8")
            from datetime import datetime
            from zoneinfo import ZoneInfo

            with patch("parser.preview_selection.parse_file", return_value=(
                datetime(2026, 9, 24, 10, tzinfo=ZoneInfo("Asia/Shanghai")),
                datetime(2026, 10, 2, tzinfo=ZoneInfo("Asia/Shanghai")),
            )):
                self.assertEqual(read_window(dll, ui, manifest)["manifest_version"], "12345")
                ui.write_bytes(b"stale")
                with self.assertRaises(ValueError):
                    read_window(dll, ui, manifest)

    def test_single_panel_mirror_is_not_merged_twice(self):
        with TemporaryDirectory() as directory:
            primary = Path(directory) / "preview.png"
            secondary = Path(directory) / "imgPreview_1.png"
            primary.write_bytes(b"first panel")
            secondary.write_bytes(b"first panel")
            with patch.object(MergeImg, "IMG_DIR", directory):
                self.assertEqual(MergeImg.get_png_files(), ["preview.png"])
                secondary.write_bytes(b"second panel")
                self.assertEqual(
                    MergeImg.get_png_files(),
                    ["preview.png", "imgPreview_1.png"],
                )


if __name__ == "__main__":
    unittest.main()
