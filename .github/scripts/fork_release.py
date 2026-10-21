#!/usr/bin/env python3
"""Build evidence and publish the fork's updater-compatible GitHub assets."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.error
import urllib.parse
import urllib.request

REPOSITORY = "alexalok/opencodex"
REPOSITORY_URL = "https://github.com/" + REPOSITORY
API = "https://api.github.com/repos/" + REPOSITORY
MAX_PACKAGE_BYTES = 128 * 1024 * 1024


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def validate_identity(version: str, sha: str) -> None:
    require(bool(re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", version)),
            "A stable X.Y.Z version is required")
    require(bool(re.fullmatch(r"[0-9a-f]{40}", sha)), "The complete lowercase source commit SHA is required")


def validate_dispatch(version: str, sha: str, env: dict) -> None:
    validate_identity(version, sha)
    require(env.get("GITHUB_REPOSITORY") == REPOSITORY, "This workflow only publishes the alexalok fork")
    require(env.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "Manual dispatch is required")
    branch = env.get("DEFAULT_BRANCH")
    require(isinstance(branch, str) and bool(branch), "Default branch is unavailable")
    require(env.get("GITHUB_REF") == "refs/heads/" + branch, "Dispatch from the fork default branch")
    require(env.get("GITHUB_SHA") == sha, "The dispatch commit differs from expected-sha")


def validate_ci(runs: list, sha: str, branch: str) -> None:
    require(bool(runs), "No Cross-platform CI push run exists for this commit")
    latest = runs[0]
    require(latest.get("headSha") == sha and latest.get("headBranch") == branch
            and latest.get("event") == "push" and latest.get("status") == "completed"
            and latest.get("conclusion") == "success",
            "The latest exact-commit default-branch push CI run must succeed before release")


def artifact_name(version: str) -> str:
    return f"opencodex-{version}-alexalok.tgz"


def initialize_bun(root: Path) -> None:
    """Repair an uninitialized npm launcher without invoking installer fallbacks."""
    version = json.loads((root / "package.json").read_text())["dependencies"]["bun"]
    require(isinstance(version, str) and bool(re.fullmatch(r"\d+\.\d+\.\d+", version)),
            "Bun must have an exact runtime pin")

    def matches(path: Path) -> bool:
        try:
            result = subprocess.run([str(path), "--version"], capture_output=True, text=True, timeout=10)
            return result.returncode == 0 and result.stdout.strip() == version
        except (OSError, subprocess.TimeoutExpired):
            return False

    target = root / "node_modules/bun/bin/bun.exe"
    bunx = target.with_name("bunx.exe")
    if matches(target) and matches(bunx):
        return
    system = {"Linux": "linux", "Darwin": "darwin"}.get(platform.system())
    arch = {"x86_64": "x64", "arm64": "aarch64", "aarch64": "aarch64"}.get(platform.machine())
    require(bool(system and arch), "Unsupported build platform")
    native = root / f"node_modules/@oven/bun-{system}-{arch}/bin/bun"
    require(matches(native), "No installed pinned Bun binary; frozen dependency installation must supply it")
    for destination in (target, bunx):
        require(destination.parent.is_dir() and not destination.is_symlink(), "Unsafe Bun launcher path")
        shutil.copyfile(native, destination)
        destination.chmod(0o755)
    require(matches(target) and matches(bunx), "Offline Bun initialization failed")


def digest(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def inspect_package(archive: Path, version: str) -> None:
    require(archive.is_file() and not archive.is_symlink()
            and 0 < archive.stat().st_size <= MAX_PACKAGE_BYTES, "Invalid package file or size")
    files = set()
    seen = set()
    total = 0
    manifest = None
    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle:
            name = member.name.rstrip("/")
            parts = name.split("/")
            total += member.size
            require(parts[0] == "package" and not any(p in ("", ".", "..") for p in parts)
                    and "\\" not in name and name not in seen and len(seen) < 20000
                    and total <= 512 * 1024 * 1024 and (member.isfile() or member.isdir()),
                    "Unsafe or oversized package archive")
            seen.add(name)
            if member.isfile():
                files.add("/".join(parts[1:]))
                if name == "package/package.json":
                    require(member.size <= 1024 * 1024, "Package manifest is too large")
                    manifest = json.load(bundle.extractfile(member))
    required = {"package.json", "bin/ocx.mjs", "src/cli/index.ts", "gui/dist/index.html",
                "src/generated/compatibility-version.json"}
    require(required.issubset(files), "Built package lacks required runtime or dashboard assets")
    require(isinstance(manifest, dict) and manifest.get("name") == "@bitkyc08/opencodex"
            and manifest.get("version") == version
            and manifest.get("opencodexFork", {}).get("repository") == REPOSITORY_URL,
            "Package version or fork identity does not match the requested release")


def prepare_package(directory: Path, version: str, sha: str) -> None:
    validate_identity(version, sha)
    archive = directory / artifact_name(version)
    inspect_package(archive, version)
    provenance = {"artifact": archive.name, "version": version, "sha256": digest(archive),
                  "source_commit": sha, "repository": REPOSITORY_URL}
    temporary = directory / ".provenance.json.tmp"
    temporary.write_text(json.dumps(provenance, indent=2) + "\n")
    temporary.replace(directory / "provenance.json")


def verify_bundle(directory: Path, version: str, sha: str) -> dict:
    validate_identity(version, sha)
    archive = directory / artifact_name(version)
    path = directory / "provenance.json"
    require(path.is_file() and not path.is_symlink() and 0 < path.stat().st_size <= 65536,
            "Invalid provenance file or size")
    provenance = json.loads(path.read_text())
    require(provenance.get("artifact") == archive.name and provenance.get("version") == version
            and provenance.get("source_commit") == sha and provenance.get("repository") == REPOSITORY_URL,
            "Provenance does not match this workflow's release")
    inspect_package(archive, version)
    require(provenance.get("sha256") == digest(archive), "Package checksum differs from provenance")
    require({p.name for p in directory.iterdir()} == {archive.name, "provenance.json"},
            "The release bundle must contain exactly the package and provenance")
    return provenance


def api(path: str, *, method="GET", data=None, missing_ok=False, upload=False):
    token = os.environ.get("GH_TOKEN")
    require(bool(token), "GH_TOKEN is required for GitHub release operations")
    base = "https://uploads.github.com/repos/" + REPOSITORY if upload else API
    payload = data if upload else json.dumps(data).encode() if data is not None else None
    request = urllib.request.Request(base + path, data=payload, method=method, headers={
        "Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "opencodex-fork-release",
        "Content-Type": "application/octet-stream" if upload else "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 404 and missing_ok:
            return None
        raise ValueError(f"GitHub release API returned HTTP {error.code}") from None


def ensure_release_absent(version: str) -> None:
    # Release-by-tag only returns published releases. The write-scoped
    # publisher must also see drafts left behind by an incomplete upload.
    for page in range(1, 21):
        releases = api(f"/releases?per_page=100&page={page}")
        require(isinstance(releases, list), "Invalid release listing")
        for release in releases:
            require(isinstance(release, dict), "Invalid release listing entry")
            require(release.get("tag_name") not in (version, "v" + version),
                    "A release or draft already exists; it will not be overwritten")
        if len(releases) < 100:
            return
    raise ValueError("Release listing pagination limit reached; version availability is unknown")


def remote_preflight(version: str, sha: str) -> None:
    validate_dispatch(version, sha, os.environ)
    repository = api("")
    branch = repository.get("default_branch")
    require(repository.get("full_name") == REPOSITORY and branch == os.environ["DEFAULT_BRANCH"],
            "The fork repository or default branch changed")
    comparison = api("/compare/" + sha + "..." + urllib.parse.quote(branch, safe=""))
    require(comparison.get("status") in ("ahead", "identical"), "Source must be merged into the default branch")
    result = subprocess.run(["gh", "run", "list", "--repo", REPOSITORY, "--workflow", "ci.yml",
                             "--branch", branch, "--commit", sha, "--event", "push", "--limit", "1",
                             "--json", "headSha,headBranch,event,status,conclusion"],
                            check=True, capture_output=True, text=True)
    validate_ci(json.loads(result.stdout), sha, branch)
    tag = "v" + version
    existing = api("/commits/" + tag, missing_ok=True)
    require(existing is None or existing.get("sha") == sha, "Existing version tag points to another commit")
    ensure_release_absent(version)


def validate_uploaded_assets(assets: list, directory: Path, version: str) -> None:
    require(len(assets) == 2, "The draft must contain exactly two release assets")
    for name in (artifact_name(version), "provenance.json"):
        matches = [a for a in assets if a.get("name") == name]
        require(len(matches) == 1, "Missing or duplicated release asset")
        asset = matches[0]
        require(asset.get("state") == "uploaded" and asset.get("size") == (directory / name).stat().st_size
                and asset.get("digest") == "sha256:" + digest(directory / name),
                "GitHub asset size or digest differs from the verified bundle")


def publish(directory: Path, version: str, sha: str) -> None:
    verify_bundle(directory, version, sha)
    remote_preflight(version, sha)
    tag = "v" + version
    # Draft creation may defer tag creation until publication. Create the exact
    # lightweight tag first, without ever replacing an existing tag.
    existing = api("/commits/" + tag, missing_ok=True)
    if existing is None:
        api("/git/refs", method="POST", data={"ref": "refs/tags/" + tag, "sha": sha})
    else:
        require(existing.get("sha") == sha, "Existing version tag points to another commit")
    release = api("/releases", method="POST", data={
        "tag_name": tag, "target_commitish": sha, "name": f"OpenCodex fork {version}",
        "draft": True, "prerelease": False,
        "body": f"Fork package built from `{sha}`.\n\nAssets include SHA-256 provenance for the host updater."
    })
    release_id = release["id"]
    require(isinstance(release_id, int) and release_id > 0, "Invalid release ID")
    # A failure leaves a draft for inspection, never a partially published release.
    for name in (artifact_name(version), "provenance.json"):
        api(f"/releases/{release_id}/assets?name=" + urllib.parse.quote(name, safe=""),
            method="POST", data=(directory / name).read_bytes(), upload=True)
    draft = api(f"/releases/{release_id}")
    require(draft.get("draft") is True and draft.get("tag_name") == tag, "Release draft changed during upload")
    validate_uploaded_assets(draft.get("assets", []), directory, version)
    require(api("/commits/" + tag).get("sha") == sha, "Release tag changed during upload")
    published = api(f"/releases/{release_id}", method="PATCH", data={"draft": False, "make_latest": "true"})
    require(published.get("draft") is False and published.get("prerelease") is False,
            "GitHub did not confirm publication")
    print(f"Published {REPOSITORY_URL}/releases/tag/{tag}")


def main() -> None:
    command, *args = sys.argv[1:]
    if command == "init-bun":
        require(not args, "init-bun takes no arguments")
        initialize_bun(Path.cwd())
    elif command == "preflight":
        version, sha = args
        remote_preflight(version, sha)
        manifest = json.loads(Path("package.json").read_text())
        require(manifest.get("version") == version, "Bump package.json before dispatching this version")
        require(manifest.get("opencodexFork", {}).get("repository") == REPOSITORY_URL,
                "Source package.json lacks fork provenance")
    else:
        directory, version, sha = args
        if command == "package":
            prepare_package(Path(directory), version, sha)
        elif command == "verify":
            verify_bundle(Path(directory), version, sha)
        elif command == "publish":
            publish(Path(directory), version, sha)
        else:
            raise ValueError("Expected preflight, package, verify, or publish")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, tarfile.TarError, subprocess.CalledProcessError) as error:
        print(f"Release refused: {error}", file=sys.stderr)
        sys.exit(1)
