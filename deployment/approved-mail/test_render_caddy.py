from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("render-caddy.py")
SPEC = importlib.util.spec_from_file_location("render_caddy", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RenderCaddyTests(unittest.TestCase):
    def test_wraps_existing_site_as_fallback_and_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            caddyfile = Path(directory) / "Caddyfile"
            caddyfile.write_text(
                "openclaw.vinzenz-geisler.com {\n"
                " reverse_proxy 127.0.0.1:18789\n"
                "}\n",
                encoding="utf-8",
            )

            self.assertTrue(MODULE.render(str(caddyfile), "/msc-approval", "18443"))
            expected = (
                "openclaw.vinzenz-geisler.com {\n"
                "  # BEGIN msc-approved-mail\n"
                "  handle /msc-approval/* {\n"
                "    reverse_proxy 127.0.0.1:18443 {\n"
                "      header_up X-MSC-Approval-Actor vinzenz\n"
                "    }\n"
                "  }\n"
                "  # END msc-approved-mail\n"
                "  handle {\n"
                "   reverse_proxy 127.0.0.1:18789\n"
                "  }\n"
                "}\n"
            )
            self.assertEqual(caddyfile.read_text(encoding="utf-8"), expected)
            self.assertFalse(MODULE.render(str(caddyfile), "/msc-approval", "18443"))
            self.assertEqual(caddyfile.read_text(encoding="utf-8"), expected)

    def test_rejects_partial_managed_block(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            caddyfile = Path(directory) / "Caddyfile"
            caddyfile.write_text(
                "example.com {\n  # BEGIN msc-approved-mail\n}\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "unerwartet"):
                MODULE.render(str(caddyfile), "/msc-approval", "18443")

    def test_rejects_content_outside_the_single_site(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            caddyfile = Path(directory) / "Caddyfile"
            caddyfile.write_text(
                "example.com {\n  reverse_proxy 127.0.0.1:18789\n}\n"
                "other.example.com {\n  respond ok\n}\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "nicht eindeutig"):
                MODULE.render(str(caddyfile), "/msc-approval", "18443")

    def test_rejects_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "target"
            target.write_text(
                "example.com {\n  reverse_proxy 127.0.0.1:18789\n}\n",
                encoding="utf-8",
            )
            link = Path(directory) / "Caddyfile"
            link.symlink_to(target)
            with self.assertRaisesRegex(ValueError, "reguläre Datei"):
                MODULE.render(str(link), "/msc-approval", "18443")


if __name__ == "__main__":
    unittest.main()
