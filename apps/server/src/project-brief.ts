import fs from "node:fs";
import path from "node:path";
import type { ProjectBrief } from "@corp-swarm/schema";

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function readJsonName(repo: string, file: string): string | null {
  const full = path.join(repo, file);
  if (!exists(full)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(full, "utf8")) as { name?: string };
    return j.name ?? null;
  } catch {
    return null;
  }
}

export function sniffProject(targetRepo: string): ProjectBrief {
  if (!exists(targetRepo) || !fs.statSync(targetRepo).isDirectory()) {
    throw new Error(`targetRepo does not exist or is not a directory: ${targetRepo}`);
  }

  const languages: string[] = [];
  const packageManagers: string[] = [];
  const testCommands: string[] = [];

  if (exists(path.join(targetRepo, "package.json"))) {
    languages.push("JavaScript/TypeScript");
    packageManagers.push("npm");
    if (exists(path.join(targetRepo, "pnpm-lock.yaml"))) packageManagers.push("pnpm");
    if (exists(path.join(targetRepo, "yarn.lock"))) packageManagers.push("yarn");
    if (exists(path.join(targetRepo, "bun.lockb")) || exists(path.join(targetRepo, "bun.lock"))) {
      packageManagers.push("bun");
    }
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(targetRepo, "package.json"), "utf8"),
      ) as { scripts?: Record<string, string> };
      if (pkg.scripts?.test) testCommands.push("npm test");
      if (pkg.scripts?.["test:unit"]) testCommands.push("npm run test:unit");
    } catch {
      /* ignore */
    }
  }

  if (exists(path.join(targetRepo, "pyproject.toml")) || exists(path.join(targetRepo, "requirements.txt"))) {
    languages.push("Python");
    if (exists(path.join(targetRepo, "pyproject.toml"))) packageManagers.push("pip/uv/poetry");
    testCommands.push("pytest");
  }

  if (exists(path.join(targetRepo, "go.mod"))) {
    languages.push("Go");
    packageManagers.push("go modules");
    testCommands.push("go test ./...");
  }

  if (exists(path.join(targetRepo, "Cargo.toml"))) {
    languages.push("Rust");
    packageManagers.push("cargo");
    testCommands.push("cargo test");
  }

  if (exists(path.join(targetRepo, "pom.xml")) || exists(path.join(targetRepo, "build.gradle"))) {
    languages.push("Java/Kotlin");
    packageManagers.push(exists(path.join(targetRepo, "pom.xml")) ? "maven" : "gradle");
  }

  if (exists(path.join(targetRepo, "Gemfile"))) {
    languages.push("Ruby");
    packageManagers.push("bundler");
  }

  if (languages.length === 0) {
    languages.push("Unknown (inspect repo structure)");
  }

  const name =
    readJsonName(targetRepo, "package.json") ??
    path.basename(targetRepo);

  const unique = <T,>(arr: T[]) => [...new Set(arr)];

  const summary = [
    `Project: ${name}`,
    `Path: ${targetRepo}`,
    `Languages: ${unique(languages).join(", ")}`,
    `Package managers: ${unique(packageManagers).join(", ") || "n/a"}`,
    `Likely test commands: ${unique(testCommands).join(", ") || "unknown — discover from repo"}`,
  ].join("\n");

  return {
    path: targetRepo,
    name,
    languages: unique(languages),
    packageManagers: unique(packageManagers),
    testCommands: unique(testCommands),
    summary,
  };
}
