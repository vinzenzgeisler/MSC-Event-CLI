import importlib.util
from importlib.machinery import SourceFileLoader
from pathlib import Path
import unittest


WRAPPER = Path(__file__).with_name("msc-event-readonly")
SPEC = importlib.util.spec_from_loader(
    "msc_event_readonly", SourceFileLoader("msc_event_readonly", str(WRAPPER))
)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


class WrapperTests(unittest.TestCase):
    def test_requests_only_support_read_scopes(self):
        self.assertTrue(MODULE.SUPPORT_READ_SCOPES)
        self.assertTrue(
            all(scope.startswith("msc-support/") for scope in MODULE.SUPPORT_READ_SCOPES)
        )
        self.assertTrue(all(scope.endswith(".read") for scope in MODULE.SUPPORT_READ_SCOPES))
        self.assertNotIn("msc-automation", " ".join(MODULE.SUPPORT_READ_SCOPES))

    def test_allows_only_narrow_read_commands(self):
        self.assertEqual(MODULE.command_args(["health"]), ["health"])
        self.assertEqual(MODULE.command_args(["lookup", "--email", "a@example.org"])[0], "lookup")
        self.assertEqual(
            MODULE.command_args(["lookup", "--codriver-name", "Max Mustermann"])[0],
            "lookup",
        )
        self.assertEqual(
            MODULE.command_args(["detail", "--id", "00000000-0000-4000-8000-000000000000"])[0],
            "detail",
        )
        self.assertEqual(
            MODULE.command_args([
                "admin-query",
                "--operation",
                "entries.list",
                "--params-json",
                '{"eventId":"00000000-0000-4000-8000-000000000000"}',
            ])[0],
            "admin-query",
        )
        self.assertEqual(
            MODULE.command_args([
                "admin-query",
                "--operation",
                "events.classes",
                "--params-json",
                '{"id":"00000000-0000-4000-8000-000000000000"}',
            ])[0],
            "admin-query",
        )

    def test_rejects_full_arbitrary_and_write_like_commands(self):
        rejected = [
            ["lookup", "--email", "a@example.org", "--full"],
            ["detail", "--id", "not-a-uuid"],
            ["delete", "--id", "00000000-0000-4000-8000-000000000000"],
            ["lookup", "--base-url", "https://evil.example"],
            ["lookup", "--name", "line\nbreak"],
            ["admin-query", "--operation", "arbitrary.http", "--params-json", "{}"],
            ["admin-query", "--operation", "entries.list", "--params-json", "[]"],
            ["admin-query", "--operation", "entries.list", "--params-json", "{broken"],
            ["admin-query", "--operation", "events.list", "--params-json", "{}"],
            ["admin-query", "--operation", "entries.get", "--params-json", '{"id":"00000000-0000-4000-8000-000000000000"}'],
            ["admin-query", "--operation", "entries.list", "--params-json", '{"eventId":"00000000-0000-4000-8000-000000000000","url":"https://evil.example"}'],
            ["admin-query", "--operation", "entries.list", "--params-json", '{"eventId":"00000000-0000-4000-8000-000000000000","acceptanceStatus":"anything"}'],
            ["admin-query", "--operation", "events.classes", "--params-json", '{"id":"00000000-0000-4000-8000-000000000000","method":"DELETE"}'],
        ]
        for argv in rejected:
            with self.subTest(argv=argv), self.assertRaises(SystemExit):
                MODULE.command_args(argv)


if __name__ == "__main__":
    unittest.main()
