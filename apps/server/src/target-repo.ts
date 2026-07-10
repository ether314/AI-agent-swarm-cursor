import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dataDir, REPO_ROOT } from "./config.js";

const execFileAsync = promisify(execFile);

export type ResolvedTarget = {
  targetRepo: string;
  githubSource: string | null;
  githubRef: string | null;
  cloned: boolean;
  pulled: boolean;
};

function isGithubSource(source: string): boolean {
  const s = source.trim();
  if (/^https?:\/\/(www\.)?github\.com\//i.test(s)) return true;
  if (/^git@github\.com:/i.test(s)) return true;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\.git)?$/.test(s)) return true;
  return false;
}

export function parseGithubSource(source: string): {
  owner: string;
  repo: string;
  cloneUrl: string;
  display: string;
} {
  let s = source.trim().replace(/\/$/, "");
  s = s.replace(/\.git$/i, "");

  let owner = "";
  let repo = "";

  const https = s.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)/i);
  const ssh = s.match(/^git@github\.com:([^/]+)\/([^/#?]+)/i);
  const short = s.match(/^([^/]+)\/([^/#?]+)$/);

  if (https) {
    owner = https[1];
    repo = https[2];
  } else if (ssh) {
    owner = ssh[1];
    repo = ssh[2];
  } else if (short) {
    owner = short[1];
    repo = short[2];
  } else {
    throw new Error(`Unrecognized GitHub source: ${source}`);
  }

  repo = repo.replace(/\.git$/i, "");
  const display = `https://github.com/${owner}/${repo}`;
  return {
    owner,
    repo,
    cloneUrl: `${display}.git`,
    display,
  };
}

async function git(
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("git", args, {
      cwd,
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(e.stderr?.trim() || e.message || String(err));
  }
}

/**
 * Resolve a CEO-provided source into a local working tree for Cursor agents.
 * Accepts an absolute/relative local path, or a GitHub URL / owner/repo.
 */
export async function resolveTargetSource(
  source: string,
  ref?: string,
): Promise<ResolvedTarget> {
  const trimmed = source.trim();
  if (!trimmed) throw new Error("source is required");

  if (isGithubSource(trimmed)) {
    const { owner, repo, cloneUrl, display } = parseGithubSource(trimmed);
    const dest = path.join(dataDir(), "repos", `${owner}__${repo}`);
    let cloned = false;
    let pulled = false;

    if (!fs.existsSync(path.join(dest, ".git"))) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (fs.existsSync(dest)) {
        throw new Error(
          `Checkout path exists but is not a git repo: ${dest}. Remove it or pick another source.`,
        );
      }
      const cloneArgs = ["clone", "--depth", "1"];
      if (ref) cloneArgs.push("--branch", ref);
      cloneArgs.push(cloneUrl, dest);
      await git(cloneArgs);
      cloned = true;
    } else {
      await git(["fetch", "--depth", "1", "origin"], dest);
      if (ref) {
        await git(["checkout", ref], dest);
        try {
          await git(["pull", "--ff-only", "origin", ref], dest);
          pulled = true;
        } catch {
          // shallow / detached ok
        }
      } else {
        try {
          await git(["pull", "--ff-only"], dest);
          pulled = true;
        } catch {
          // ignore if no tracking branch
        }
      }
    }

    return {
      targetRepo: dest,
      githubSource: display,
      githubRef: ref ?? null,
      cloned,
      pulled,
    };
  }

  const localPath = path.isAbsolute(trimmed)
    ? trimmed
    : path.resolve(REPO_ROOT, trimmed);

  if (!fs.existsSync(localPath) || !fs.statSync(localPath).isDirectory()) {
    throw new Error(`Local path does not exist or is not a directory: ${localPath}`);
  }

  return {
    targetRepo: localPath,
    githubSource: null,
    githubRef: null,
    cloned: false,
    pulled: false,
  };
}
