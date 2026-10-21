"""Fork release contract tests; no network calls or publication."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("fork_release.py")
SHA = "a" * 40
VERSION = "2.90.0"
REPO = "alexalok/opencodex"


def load():
    spec = importlib.util.spec_from_file_location("fork_release", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ForkRelease(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archive = self.root / "opencodex-2.90.0-alexalok.tgz"

    def package(self, *, version=VERSION, repository="https://github.com/alexalok/opencodex", extra=None, missing=None):
        manifest = {"name": "@bitkyc08/opencodex", "version": version,
                    "opencodexFork": {"repository": repository}}
        files = {"package/package.json": json.dumps(manifest).encode(),
                 "package/bin/ocx.mjs": b"// launcher", "package/src/cli/index.ts": b"// runtime",
                 "package/gui/dist/index.html": b"<html></html>",
                 "package/src/generated/compatibility-version.json": b"{}"}
        files.pop(missing, None)
        with tarfile.open(self.archive, "w:gz") as tar:
            for name, data in files.items():
                member = tarfile.TarInfo(name); member.size = len(data)
                tar.addfile(member, io.BytesIO(data))
            if extra:
                tar.addfile(extra, io.BytesIO(b"x") if extra.isfile() else None)

    def test_package_command_produces_updater_provenance(self):
        self.package()
        result = subprocess.run([sys.executable, str(SCRIPT), "package", str(self.root), VERSION, SHA],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        provenance = json.loads((self.root / "provenance.json").read_text())
        self.assertEqual(provenance["artifact"], "opencodex-2.90.0-alexalok.tgz")
        self.assertEqual(provenance["version"], "2.90.0")
        self.assertEqual(provenance["source_commit"], SHA)
        self.assertEqual(provenance["sha256"], hashlib.sha256(self.archive.read_bytes()).hexdigest())

    def test_rejects_non_fork_identity_wrong_version_and_missing_assets(self):
        u = load()
        for kwargs in [{"repository": "https://github.com/lidge-jun/opencodex"},
                       {"version": "2.84.1"}, {"missing": "package/gui/dist/index.html"}]:
            with self.subTest(kwargs=kwargs):
                self.package(**kwargs)
                with self.assertRaises(ValueError): u.inspect_package(self.archive, VERSION)

    def test_rejects_archive_traversal_links_and_duplicate_files(self):
        u = load()
        for name, kind in [("package/../outside", tarfile.REGTYPE), ("/absolute", tarfile.REGTYPE),
                           ("package/link", tarfile.SYMTYPE), ("package/package.json", tarfile.REGTYPE)]:
            member = tarfile.TarInfo(name); member.type = kind
            member.size = 1 if kind == tarfile.REGTYPE else 0; member.linkname = "/etc/passwd"
            self.package(extra=member)
            with self.subTest(name=name), self.assertRaises(ValueError): u.inspect_package(self.archive, VERSION)

    def test_verify_rejects_tampered_package_or_provenance(self):
        u = load(); self.package(); u.prepare_package(self.root, VERSION, SHA)
        path = self.root / "provenance.json"; original = path.read_text()
        for field, value in [("artifact", "../outside"), ("source_commit", "b" * 40),
                             ("version", "2.90.1"), ("sha256", "c" * 64)]:
            data = json.loads(original); data[field] = value; path.write_text(json.dumps(data))
            with self.subTest(field=field), self.assertRaises(ValueError): u.verify_bundle(self.root, VERSION, SHA)
        path.write_text(original)
        self.archive.write_bytes(self.archive.read_bytes() + b"changed")
        with self.assertRaises(ValueError): u.verify_bundle(self.root, VERSION, SHA)

    def test_dispatch_requires_fork_default_branch_exact_sha_and_stable_version(self):
        u = load()
        valid = {"GITHUB_REPOSITORY": REPO, "GITHUB_EVENT_NAME": "workflow_dispatch",
                 "GITHUB_REF": "refs/heads/main", "DEFAULT_BRANCH": "main", "GITHUB_SHA": SHA}
        u.validate_dispatch(VERSION, SHA, valid)
        for key, value in [("GITHUB_REPOSITORY", "lidge-jun/opencodex"),
                           ("GITHUB_EVENT_NAME", "push"), ("GITHUB_REF", "refs/heads/dev"),
                           ("GITHUB_SHA", "b" * 40), ("DEFAULT_BRANCH", "")]:
            env = {**valid, key: value}
            with self.subTest(key=key), self.assertRaises(ValueError): u.validate_dispatch(VERSION, SHA, env)
        for version, sha in [("2.90.0-preview.1", SHA), ("2.90.0\nignored", SHA),
                             ("02.90.0", SHA), (VERSION, "a" * 7)]:
            with self.subTest(version=version, sha=sha), self.assertRaises(ValueError):
                u.validate_dispatch(version, sha, valid)

    def test_ci_requires_latest_exact_commit_default_branch_push_success(self):
        u = load()
        good = {"headSha": SHA, "headBranch": "main", "event": "push",
                "status": "completed", "conclusion": "success"}
        u.validate_ci([good], SHA, "main")
        for field, value in [("headSha", "b" * 40), ("headBranch", "dev"),
                             ("event", "pull_request"), ("status", "in_progress"),
                             ("conclusion", "failure"), ("conclusion", "skipped")]:
            bad = {**good, field: value}
            with self.subTest(field=field), self.assertRaises(ValueError):
                u.validate_ci([bad], SHA, "main")
        with self.assertRaises(ValueError): u.validate_ci([], SHA, "main")
        with self.assertRaises(ValueError): u.validate_ci([{**good, "conclusion": "failure"}, good], SHA, "main")

    def test_release_upload_digests_must_match_both_local_assets(self):
        u = load(); self.package(); u.prepare_package(self.root, VERSION, SHA)
        assets = [{"name": name, "size": (self.root / name).stat().st_size,
                   "digest": "sha256:" + hashlib.sha256((self.root / name).read_bytes()).hexdigest(),
                   "state": "uploaded"} for name in [self.archive.name, "provenance.json"]]
        u.validate_uploaded_assets(assets, self.root, VERSION)
        for mutation in [lambda a: a.pop(), lambda a: a.append(copy.deepcopy(a[0])),
                         lambda a: a[0].update(digest="sha256:" + "0" * 64),
                         lambda a: a[1].update(state="new")]:
            bad = copy.deepcopy(assets); mutation(bad)
            with self.assertRaises(ValueError): u.validate_uploaded_assets(bad, self.root, VERSION)

    def test_existing_draft_is_rejected_even_on_second_release_page(self):
        u = load()
        for tag in ("v2.90.0", "2.90.0"):
            def api(path):
                if path == "/releases?per_page=100&page=1":
                    return [{"tag_name": "v1.0.0", "draft": False}] * 100
                if path == "/releases?per_page=100&page=2":
                    return [{"tag_name": tag, "draft": True}]
                raise AssertionError("Unexpected release lookup: " + path)
            with self.subTest(tag=tag), patch.object(u, "api", side_effect=api):
                with self.assertRaisesRegex(ValueError, "already exists"):
                    u.ensure_release_absent(VERSION)

    def test_absent_release_can_proceed_but_malformed_listing_cannot(self):
        u = load()
        with patch.object(u, "api", return_value=[]):
            u.ensure_release_absent(VERSION)
        with patch.object(u, "api", return_value={"message": "unavailable"}):
            with self.assertRaises(ValueError): u.ensure_release_absent(VERSION)

    def test_bun_initialization_uses_only_installed_pinned_binary(self):
        u = load()
        (self.root / "package.json").write_text(json.dumps({"dependencies": {"bun": "1.4.2"}}))
        target = self.root / "node_modules/bun/bin/bun.exe"
        native = self.root / "node_modules/@oven/bun-linux-x64/bin/bun"
        target.parent.mkdir(parents=True); native.parent.mkdir(parents=True)
        target.write_text("#!/bin/sh\nexit 1\n"); target.chmod(0o755)
        with patch.object(u.platform, "system", return_value="Linux"), \
             patch.object(u.platform, "machine", return_value="x86_64"):
            with self.assertRaisesRegex(ValueError, "installed pinned"):
                u.initialize_bun(self.root)
            self.assertIn("exit 1", target.read_text())
            native.write_text("#!/bin/sh\nprintf '1.4.1\\n'\n"); native.chmod(0o755)
            with self.assertRaisesRegex(ValueError, "installed pinned"):
                u.initialize_bun(self.root)
            native.write_text("#!/bin/sh\nprintf '1.4.2\\n'\n"); native.chmod(0o755)
            u.initialize_bun(self.root)
            self.assertEqual(target.read_bytes(), native.read_bytes())
            self.assertEqual(target.with_name("bunx.exe").read_bytes(), native.read_bytes())
            native.unlink()
            u.initialize_bun(self.root)  # Working launchers need no optional package or network.

    def publishing_api(self, *, corrupt_asset=False):
        self.remote = {"tag": None, "release": None, "assets": []}
        def api(path, *, method="GET", data=None, missing_ok=False, upload=False):
            if path == "/commits/v2.90.0":
                if self.remote["tag"] is None:
                    if missing_ok: return None
                    raise ValueError("Tag does not exist until explicitly created or published")
                return {"sha": self.remote["tag"]}
            if path == "/git/refs" and method == "POST":
                self.assertEqual(data, {"ref": "refs/tags/v2.90.0", "sha": SHA})
                self.remote["tag"] = data["sha"]
                return {"object": {"sha": SHA}}
            if path == "/releases" and method == "POST":
                self.remote["release"] = {"id": 7, **data, "assets": self.remote["assets"]}
                return copy.deepcopy(self.remote["release"])
            if path.startswith("/releases/7/assets?name=") and method == "POST" and upload:
                name = path.split("=", 1)[1]
                self.remote["assets"].append({"name": name, "size": len(data), "state": "uploaded",
                    "digest": "sha256:" + ("0" * 64 if corrupt_asset else hashlib.sha256(data).hexdigest())})
                return copy.deepcopy(self.remote["assets"][-1])
            if path == "/releases/7":
                if method == "PATCH": self.remote["release"].update(data)
                return copy.deepcopy(self.remote["release"])
            raise AssertionError("Unexpected GitHub operation: " + method + " " + path)
        return api

    def test_publishes_only_complete_verified_draft_with_exact_tag(self):
        u = load(); self.package(); u.prepare_package(self.root, VERSION, SHA)
        with patch.object(u, "remote_preflight"), patch.object(u, "api", side_effect=self.publishing_api()), \
             patch("sys.stdout", new_callable=io.StringIO):
            u.publish(self.root, VERSION, SHA)
        self.assertEqual(self.remote["tag"], SHA)
        self.assertFalse(self.remote["release"]["draft"])
        self.assertEqual({a["name"] for a in self.remote["assets"]},
                         {"opencodex-2.90.0-alexalok.tgz", "provenance.json"})

    def test_upload_integrity_failure_leaves_unpublished_draft(self):
        u = load(); self.package(); u.prepare_package(self.root, VERSION, SHA)
        with patch.object(u, "remote_preflight"), \
             patch.object(u, "api", side_effect=self.publishing_api(corrupt_asset=True)):
            with self.assertRaisesRegex(ValueError, "digest"):
                u.publish(self.root, VERSION, SHA)
        self.assertTrue(self.remote["release"]["draft"])


if __name__ == "__main__":
    unittest.main()
