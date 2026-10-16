import { getConfig } from "./config.js";

/** Cached result of collaborator/owner checks. */
const collaboratorCache = new Map<string, { isCollab: boolean; timestamp: number }>();
const COLLABORATOR_CACHE_TTL_MS = 300_000; // 5 min

export function clearCollaboratorCache(): void {
  collaboratorCache.clear();
}

/** Check whether a user is a collaborator/owner of a repo (cached). Fails closed. */
export async function checkCollaborator(
  githubToken: string,
  repoFullName: string,
  username: string
): Promise<boolean> {
  const now = Date.now();
  const cacheKey = `${repoFullName}:${username}`;
  const cached = collaboratorCache.get(cacheKey);
  if (cached && now - cached.timestamp < COLLABORATOR_CACHE_TTL_MS) {
    return cached.isCollab;
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repoFullName}/collaborators/${encodeURIComponent(username)}`,
      {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github.v3+json",
        },
      }
    );
    const isCollab = res.status === 204 || res.ok;
    collaboratorCache.set(cacheKey, { isCollab, timestamp: now });
    return isCollab;
  } catch {
    // Fail closed, but do not cache transient network errors
    return false;
  }
}

/** Signature used by comment commands: (owner, repo, username). */
export async function isCollaborator(
  owner: string,
  repo: string,
  username: string
): Promise<boolean> {
  return checkCollaborator(getConfig().githubToken, `${owner}/${repo}`, username);
}
