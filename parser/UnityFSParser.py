"""Export the current preview panel and, during a window, the following panel."""

from __future__ import annotations

from shutil import copyfile
from pathlib import Path

import UnityPy
from PIL import Image

from preview_selection import manifest_version, read_window, select_panels

ROOT = Path(__file__).resolve().parent.parent
BUNDLE = ROOT / "DefaultPackage" / "game_ui_activitylistpreview"
MANIFEST = ROOT / "DefaultPackage" / "PackageManifest_DefaultPackage.json"
DLL = ROOT / "DefaultPackage" / "game_dll_gamelogic_dll_bytes"
IMAGE_DIR = ROOT / "img"
MAX_WIDTH = 1024


def read_panels() -> dict[str, tuple[bool, Image.Image]]:
    environment = UnityPy.load(str(BUNDLE))
    objects = {item.path_id: item for item in environment.objects}
    panels: dict[str, tuple[bool, Image.Image]] = {}
    for item in environment.objects:
        if item.type.name != "GameObject":
            continue
        try:
            game_object = item.read()
        except Exception:
            continue
        if game_object.m_Name not in {"imgPreview", "imgPreview_1"}:
            continue
        for component in game_object.m_Component:
            reader = component.component
            if reader.type.name != "MonoBehaviour":
                continue
            try:
                sprite_id = reader.read_typetree().get("m_Sprite", {}).get("m_PathID")
                sprite = objects[sprite_id].read() if sprite_id in objects else None
                if sprite is not None:
                    panels[game_object.m_Name] = (
                        bool(game_object.m_IsActive),
                        sprite.image.copy(),
                    )
                    break
            except Exception as error:
                print(f"Could not read {game_object.m_Name}: {error}")
    return panels


def save_panel(image: Image.Image, path: Path) -> None:
    if image.width > MAX_WIDTH:
        height = round(image.height * MAX_WIDTH / image.width)
        image = image.resize((MAX_WIDTH, height), Image.Resampling.LANCZOS)
    image.save(path)
    print(f"Exported {path.name}: {image.width}x{image.height}")


def main() -> None:
    panels = read_panels()
    version = manifest_version(MANIFEST)
    window = read_window(DLL, BUNDLE, MANIFEST)
    if window["manifest_version"] != version:
        raise ValueError("Preview DLL and UI asset versions do not match")
    selected = select_panels(
        {name: active for name, (active, _) in panels.items()}, window
    )
    print(f"Asset version {version}; selected panels: {', '.join(selected)}")

    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    for filename in (
        "preview.png",
        "imgPreview.png",
        "imgPreview_1.png",
        "combined.png",
    ):
        (IMAGE_DIR / filename).unlink(missing_ok=True)
    for index, name in enumerate(selected):
        filename = "preview.png" if index == 0 else "imgPreview_1.png"
        save_panel(panels[name][1], IMAGE_DIR / filename)
    if len(selected) == 1:
        copyfile(IMAGE_DIR / "preview.png", IMAGE_DIR / "imgPreview_1.png")
        print("Single panel: secondary URL mirrors the primary for compatibility")


if __name__ == "__main__":
    main()
