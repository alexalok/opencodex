/** Backport forks compare releases in their own ancestry, not unrelated upstream tags. */
export function releaseTagListArgs(metadata: unknown): string[] {
  const args = ["tag", "--list", "v*"];
  if (!metadata || typeof metadata !== "object") return args;
  const fork = (metadata as { opencodexFork?: unknown }).opencodexFork;
  if (!fork || typeof fork !== "object") return args;
  const repository = (fork as { repository?: unknown }).repository;
  if (typeof repository !== "string") return args;
  // Fail closed for malformed metadata and preserve upstream's global release guard.
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/opencodex(?:\.git)?\/?$/.exec(repository);
  if (!match || match[1]!.toLowerCase() === "lidge-jun") return args;
  return [...args, "--merged", "HEAD"];
}
