"""Extract the preview panel's display dates from the official game DLL."""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
import struct
from zoneinfo import ZoneInfo

import dnfile

PANEL = "ActivityListPreviewPanel"
NAMESPACE = "module.activityListPreview"
FIELDS = ("s_T1StartTime", "s_T1EndTime")


def _type_row(table: object, name: str) -> int:
    data = table._table_data  # type: ignore[attr-defined]
    strings = table._strings_heap.__data__  # type: ignore[attr-defined]
    offset = strings.find(name.encode() + b"\0")
    if offset < 0:
        raise ValueError(f"DLL is missing {name}")
    width = table._strings_offset_size  # type: ignore[attr-defined]
    needle = offset.to_bytes(width, "little")
    size = table.row_size  # type: ignore[attr-defined]
    for index in range(table.num_rows):  # type: ignore[attr-defined]
        if data[index * size + 4 : index * size + 4 + width] == needle:
            return index
    raise ValueError(f"DLL has no type row for {name}")


def _method_body(image: object, rva: int) -> bytes:
    header = image.get_data(rva, 12)  # type: ignore[attr-defined]
    if not header:
        raise ValueError("Empty method body")
    if header[0] & 3 == 2:
        size, length = 1, header[0] >> 2
    elif header[0] & 3 == 3:
        size = (int.from_bytes(header[:2], "little") >> 12) * 4
        length = int.from_bytes(header[4:8], "little")
    else:
        raise ValueError("Invalid method header")
    if size < 1 or length > 4096:
        raise ValueError("Unexpected preview initializer size")
    return image.get_data(rva, size + length)[size:]  # type: ignore[attr-defined]


def _date_for_field(image: object, il: bytes, row: int) -> datetime:
    assignment = il.find(b"\x80" + struct.pack("<I", 0x04000000 | row))
    if assignment < 0:
        raise ValueError("Missing preview field assignment")
    found: list[str] = []
    for index in range(assignment):
        if il[index] != 0x72 or index + 5 > assignment:
            continue
        token = struct.unpack_from("<I", il, index + 1)[0]
        if token >> 24 != 0x70:
            continue
        value = image.net.user_strings.get(token & 0xFFFFFF)  # type: ignore[attr-defined]
        if value is None:
            continue
        try:
            date = datetime.fromisoformat(str(value))
        except ValueError:
            continue
        if date.year >= 2020 and date.year <= 2100:
            found.append(str(value))
    if not found:
        raise ValueError("Missing preview date literal")
    return datetime.fromisoformat(found[-1]).replace(tzinfo=ZoneInfo("Asia/Shanghai"))


def parse_window(dll: bytes) -> tuple[datetime, datetime]:
    image = dnfile.dnPE(data=dll, clr_lazy_load=True)
    if image.net is None:
        raise ValueError("Not a .NET game DLL")
    types = image.net.mdtables.TypeDef
    fields = image.net.mdtables.Field
    methods = image.net.mdtables.MethodDef
    index = _type_row(types, PANEL)
    panel, next_type = types.rows[index], types.rows[index + 1]
    if str(panel.TypeNamespace) != NAMESPACE:
        raise ValueError("Unexpected preview panel namespace")
    field_rows = {
        str(fields.rows[row - 1].Name): row
        for row in range(panel.struct.FieldList_Index, next_type.struct.FieldList_Index)
    }
    if any(field not in field_rows for field in FIELDS):
        raise ValueError("Preview window fields are missing")
    constructors = [
        methods.rows[row - 1]
        for row in range(panel.struct.MethodList_Index, next_type.struct.MethodList_Index)
        if str(methods.rows[row - 1].Name) == ".cctor"
    ]
    if len(constructors) != 1:
        raise ValueError("Preview panel has no unique static initializer")
    il = _method_body(image, constructors[0].Rva)
    start, end = (_date_for_field(image, il, field_rows[name]) for name in FIELDS)
    if start >= end or end - start > timedelta(days=60):
        raise ValueError("Invalid preview display window")
    return start, end


def parse_file(path: Path) -> tuple[datetime, datetime]:
    return parse_window(path.read_bytes())
