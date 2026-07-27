#!/usr/bin/env python3

from __future__ import annotations

import os
import re
import sys
import tempfile
from pathlib import Path

BEGIN = "# BEGIN msc-approved-mail"
END = "# END msc-approved-mail"


def render(path_value: str, base_path: str, port_value: str) -> bool:
    path = Path(path_value)
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise ValueError("Caddy-Konfiguration ist keine absolute reguläre Datei.")
    if not re.fullmatch(r"/[A-Za-z0-9/_-]+", base_path):
        raise ValueError("MSC-Basispfad ist ungültig.")
    port = int(port_value)
    if port < 1 or port > 65535:
        raise ValueError("MSC-Listener-Port ist ungültig.")

    original = path.read_text(encoding="utf-8").splitlines(keepends=True)
    text = "".join(original)
    managed = (
        f"  {BEGIN}\n"
        f"  handle {base_path}/* {{\n"
        f"    reverse_proxy 127.0.0.1:{port} {{\n"
        "      header_up X-MSC-Approval-Actor vinzenz\n"
        "    }\n"
        "  }\n"
        f"  {END}\n"
    )
    if BEGIN in text or END in text:
        if text.count(BEGIN) != 1 or text.count(END) != 1 or managed not in text:
            raise ValueError("Vorhandener MSC-Caddy-Block ist unerwartet.")
        return False

    depth = 0
    openings: list[tuple[int, re.Match[str]]] = []
    closings: list[int] = []
    for index, line in enumerate(original):
        if depth == 0:
            site = re.fullmatch(
                r"\s*([A-Za-z0-9.-]+)\s*\{\s*(?:#.*)?\n?",
                line,
            )
            if site:
                openings.append((index, site))
            elif line.strip() and not line.lstrip().startswith("#"):
                raise ValueError(
                    "Caddy-Konfiguration außerhalb des Siteblocks ist unerwartet."
                )
        depth += line.count("{") - line.count("}")
        if depth < 0:
            raise ValueError("Caddy-Siteblock ist nicht eindeutig.")
        if depth == 0 and line.strip() == "}":
            closings.append(index)
    if depth != 0 or len(openings) != 1 or len(closings) != 1:
        raise ValueError("Caddy-Siteblock ist nicht eindeutig.")
    opening, site = openings[0]
    closing = closings[0]
    if "." not in site.group(1) or closing <= opening + 1:
        raise ValueError("Caddy-Siteblock ist nicht eindeutig.")

    body = original[opening + 1 : closing]
    if not any(
        line.strip() and not line.lstrip().startswith("#") for line in body
    ):
        raise ValueError("Caddy-Siteblock besitzt keine bestehende Route.")
    fallback = ["  handle {\n"]
    fallback.extend("  " + line if line.strip() else line for line in body)
    fallback.append("  }\n")
    updated = original[: opening + 1] + [managed] + fallback + original[closing:]

    metadata = path.stat(follow_symlinks=False)
    descriptor, temporary_value = tempfile.mkstemp(
        prefix=".Caddyfile.msc-", dir=path.parent
    )
    temporary = Path(temporary_value)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.writelines(updated)
            handle.flush()
            os.fsync(handle.fileno())
        os.chown(temporary, metadata.st_uid, metadata.st_gid)
        os.chmod(temporary, metadata.st_mode & 0o777)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return True


def main() -> int:
    if len(sys.argv) != 4:
        print(
            "Aufruf: render-caddy.py CADDYFILE BASE_PATH PORT",
            file=sys.stderr,
        )
        return 2
    try:
        render(*sys.argv[1:])
    except (OSError, ValueError) as error:
        print(f"[msc-approved-mail] FEHLER: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
