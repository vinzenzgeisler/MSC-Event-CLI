import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("host-install.sh")


class HostInstallHealthWaitTests(unittest.TestCase):
    def run_bash(self, body: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", "-c", f'source "$SCRIPT"\n{body}'],
            check=False,
            capture_output=True,
            text=True,
            env={**os.environ, "SCRIPT": str(SCRIPT)},
        )

    def test_transient_unhealthy_state_is_retried_until_healthy(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            counter = Path(directory, "inspect-count")
            result = self.run_bash(
                f"""
GATEWAY_SERVICE=gateway
compose() {{ printf '%s\\n' container-id; }}
sleep() {{ :; }}
docker() {{
  if [[ "$1" == inspect && "$2" == -f ]]; then
    count=0
    [[ -f {counter!s} ]] && read -r count < {counter!s}
    count=$((count + 1))
    printf '%s\\n' "$count" > {counter!s}
    if ((count == 1)); then printf '%s\\n' unhealthy
    else printf '%s\\n' healthy; fi
    return 0
  fi
  return 1
}}
wait_for_gateway_health 2
printf 'container=%s\\n' "$GATEWAY_CONTAINER"
printf 'attempts='
cat {counter!s}
"""
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("container=container-id", result.stdout)
        self.assertIn("attempts=2", result.stdout)

    def test_persistent_unhealthy_state_times_out(self) -> None:
        result = self.run_bash(
            """
GATEWAY_SERVICE=gateway
compose() { printf '%s\\n' container-id; }
docker() {
  if [[ "$1" == inspect && "$2" == -f ]]; then
    printf '%s\\n' unhealthy
    return 0
  fi
  return 0
}
if wait_for_gateway_health 1; then exit 9; fi
"""
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Gateway-Diagnose nach Zeitüberschreitung", result.stderr)

    def test_empty_compose_directory_placeholders_are_removed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            production = root / "production.json"
            proposal = root / "proposal.json"
            bootstrap = root / "bootstrap.json"
            production.mkdir()
            proposal.write_text("{}\n", encoding="utf-8")
            bootstrap.mkdir()
            result = self.run_bash(
                f"""
prepare_configuration_paths {production!s} {proposal!s} {bootstrap!s}
[[ ! -e {production!s} ]]
[[ -f {proposal!s} ]]
[[ ! -e {bootstrap!s} ]]
"""
            )

        self.assertEqual(result.returncode, 0, result.stderr)

    def test_nonempty_configuration_directory_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            production = root / "production.json"
            proposal = root / "proposal.json"
            bootstrap = root / "bootstrap.json"
            production.mkdir()
            Path(production, "unexpected").write_text("keep\n", encoding="utf-8")
            result = self.run_bash(
                f"""
prepare_configuration_paths {production!s} {proposal!s} {bootstrap!s}
"""
            )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("nichtleeres Verzeichnis", result.stderr)

    def test_plugin_update_preserves_configuration_owner_and_mode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory, "openclaw.json")
            config.write_text(
                json.dumps({"plugins": {"allow": []}}),
                encoding="utf-8",
            )
            config.chmod(0o640)
            before = config.stat()
            result = self.run_bash(f"enable_plugin {config!s}")
            after = config.stat()
            value = json.loads(config.read_text(encoding="utf-8"))

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(after.st_uid, before.st_uid)
        self.assertEqual(after.st_gid, before.st_gid)
        self.assertEqual(stat.S_IMODE(after.st_mode), 0o640)
        self.assertIn(
            "/opt/msc-approved-mail/plugin/production.mjs",
            value["plugins"]["load"]["paths"],
        )
        self.assertTrue(value["plugins"]["entries"]["msc-approved-mail"]["enabled"])
        self.assertIn("msc-approved-mail", value["plugins"]["allow"])


if __name__ == "__main__":
    unittest.main()
