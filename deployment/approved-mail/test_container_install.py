import subprocess
import tempfile
import unittest
import json
from pathlib import Path


SCRIPT = Path(__file__).with_name("container-install.sh")


class ContainerInstallTests(unittest.TestCase):
    def test_script_is_valid_bash(self) -> None:
        result = subprocess.run(
            ["bash", "-n", str(SCRIPT)],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_architecture_has_no_host_control_plane_dependencies(self) -> None:
        source = SCRIPT.read_text(encoding="utf-8")
        for forbidden in (
            "docker",
            "docker-compose",
            "caddy",
            "systemctl",
            "/var/run/docker.sock",
            "18443:18443",
            "/usr/local/bin/msc:",
        ):
            self.assertNotIn(forbidden, source.lower())

    def test_installer_never_restarts_the_gateway_itself(self) -> None:
        source = SCRIPT.read_text(encoding="utf-8")
        self.assertNotIn("gateway restart", source.lower())
        self.assertNotIn("sigusr1", source.lower())

    def test_native_plugin_package_is_installed(self) -> None:
        source = SCRIPT.read_text(encoding="utf-8")
        self.assertIn("plugin/production-package", source)
        self.assertIn("openclaw plugins doctor", source)
        self.assertIn("msc_mail_reply_propose", source)
        self.assertIn("msc_mail_reply_send", source)
        self.assertIn("MSC_APPROVED_MAIL_OPERATOR_SESSION_KEY", source)
        self.assertIn("agent:main:telegram:direct:8261978945", source)
        self.assertIn('rmdir -- "$STAGING_ROOT"', source)

    def test_native_plugin_manifest_declares_all_optional_tools(self) -> None:
        manifest = json.loads(
            Path(
                __file__,
            ).parents[2].joinpath(
                "plugin/production-package/openclaw.plugin.json",
            ).read_text(encoding="utf-8")
        )
        self.assertEqual(
            manifest["contracts"]["tools"],
            [
                "msc_mail_watch_list",
                "msc_mail_reply_propose",
                "msc_mail_reply_send",
                "msc_event_entry_change_propose",
                "msc_event_entry_change_execute",
            ],
        )
        self.assertTrue(manifest["toolMetadata"]["msc_mail_watch_list"]["optional"])
        self.assertTrue(manifest["toolMetadata"]["msc_mail_reply_propose"]["optional"])
        self.assertTrue(manifest["toolMetadata"]["msc_mail_reply_send"]["optional"])
        self.assertTrue(
            manifest["toolMetadata"]["msc_event_entry_change_propose"]["optional"]
        )
        self.assertTrue(
            manifest["toolMetadata"]["msc_event_entry_change_execute"]["optional"]
        )

    def test_installer_binds_signature_and_nennung_bcc_policy(self) -> None:
        source = SCRIPT.read_text(encoding="utf-8")
        self.assertIn("Mit freundlichen Grüßen", source)
        self.assertIn("Vinzenz Geisler", source)
        self.assertIn("replySignature", source)
        self.assertIn("replyBccToSelf: account === 'msc-nennung'", source)

    def test_private_file_check_rejects_world_readable_mode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            private_file = Path(directory, "secret")
            private_file.write_text("secret", encoding="utf-8")
            private_file.chmod(0o604)
            result = subprocess.run(
                [
                    "bash",
                    "-c",
                    'source "$1"; require_private_regular_file "$2" 600',
                    "test",
                    str(SCRIPT),
                    str(private_file),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("zu weit freigegeben", result.stderr)


if __name__ == "__main__":
    unittest.main()
