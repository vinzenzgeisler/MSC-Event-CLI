import os
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


if __name__ == "__main__":
    unittest.main()
