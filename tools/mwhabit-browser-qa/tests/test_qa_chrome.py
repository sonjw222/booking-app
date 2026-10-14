import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("qa_chrome",
    pathlib.Path(__file__).resolve().parents[1] / "qa_chrome.py")
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)

class TestSafety(unittest.TestCase):
    def fixture(self, ref="abcdefghijklmnopqrst"):
        return {"NEXT_PUBLIC_SUPABASE_URL": "https://" + ref + ".supabase.co",
                "NEXT_PUBLIC_SUPABASE_ANON_KEY": "fake",
                "SUPABASE_SERVICE_ROLE_KEY": "fake"}

    def test_dev_ref(self):
        self.assertEqual(qa.validate_target(self.fixture(), "abcdefghijklmnopqrst"),
                         "abcdefghijklmnopqrst")

    def test_prod_block(self):
        with self.assertRaises(qa.Blocked):
            qa.validate_target(self.fixture(qa.REF_PROD), qa.REF_PROD)

    def test_unknown_ref_block(self):
        with self.assertRaises(qa.Blocked):
            qa.validate_target(self.fixture(), "")

    def test_wrong_ref_block(self):
        with self.assertRaises(qa.Blocked):
            qa.validate_target(self.fixture(), "bbbbbbbbbbbbbbbbbbbb")

    def test_non_supabase_url_block(self):
        env = self.fixture()
        env["NEXT_PUBLIC_SUPABASE_URL"] = "https://example.com"
        with self.assertRaises(qa.Blocked):
            qa.validate_target(env, "abcdefghijklmnopqrst")

    def test_missing_keys_block(self):
        env = self.fixture()
        del env["SUPABASE_SERVICE_ROLE_KEY"]
        with self.assertRaises(qa.Blocked):
            qa.validate_target(env, "abcdefghijklmnopqrst")

    def test_plain_text_pass_rejected(self):
        self.assertEqual(qa.judge("PASS", set())[0], "BLOCKED")

    def test_json_pass_without_tools_rejected(self):
        obj = json.dumps({"status": "PASS", "checks": dict.fromkeys(qa.CHECKS, True)})
        self.assertEqual(qa.judge(obj, set())[0], "BLOCKED")

    def test_all_browser_tools_required(self):
        tools = {"mcp__claude-in-chrome__" + x for x in qa.REQUIRED_TOOLS}
        obj = json.dumps({"status": "PASS", "checks": dict.fromkeys(qa.CHECKS, True)})
        self.assertEqual(qa.judge(obj, tools)[0], "PASS_REPORTED")
        tools.remove("mcp__claude-in-chrome__navigate")
        self.assertEqual(qa.judge(obj, tools)[0], "BLOCKED")

    def test_incomplete_checks_fail(self):
        tools = {"mcp__claude-in-chrome__" + x for x in qa.REQUIRED_TOOLS}
        obj = json.dumps({"status": "PASS", "checks": {"login": True}})
        self.assertEqual(qa.judge(obj, tools)[0], "FAIL")

    def test_permission_requirements(self):
        with tempfile.TemporaryDirectory() as td:
            path = pathlib.Path(td) / "browser-qa.env"
            path.write_text("NTFY_TOPIC=private\n")
            path.chmod(0o644)
            with self.assertRaises(qa.Blocked):
                qa.read_env(path)
            path.chmod(0o600)
            self.assertEqual(qa.read_env(path)["NTFY_TOPIC"], "private")

    def test_issue_label_scope(self):
        with patch.object(qa.subprocess, "run") as mocked:
            mocked.return_value.returncode = 0
            mocked.return_value.stdout = json.dumps(
                {"number": 219, "state": "OPEN", "author":{"login":"sonjw222"},
                 "labels":[{"name":qa.LABEL}]})
            self.assertTrue(qa.issue_is_approved())
            mocked.return_value.stdout = json.dumps(
                {"number": 219, "state": "OPEN", "author":{"login":"sonjw222"},
                 "labels":[{"name":"ai-dev-approved"}]})
            self.assertFalse(qa.issue_is_approved())

if __name__ == "__main__":
    unittest.main()
