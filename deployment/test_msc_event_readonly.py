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

    def test_rejects_full_arbitrary_and_write_like_commands(self):
        rejected = [
            ["lookup", "--email", "a@example.org", "--full"],
            ["detail", "--id", "not-a-uuid"],
            ["delete", "--id", "00000000-0000-4000-8000-000000000000"],
            ["lookup", "--base-url", "https://evil.example"],
            ["lookup", "--name", "line\nbreak"],
        ]
        for argv in rejected:
            with self.subTest(argv=argv), self.assertRaises(SystemExit):
                MODULE.command_args(argv)


if __name__ == "__main__":
    unittest.main()
