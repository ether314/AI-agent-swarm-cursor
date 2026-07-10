import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SwarmConfigSchema, type SwarmConfig } from "@corp-swarm/schema";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "../../..");

export function loadConfig(): SwarmConfig {
  const configPath = path.join(REPO_ROOT, "corp-swarm.config.json");
  const localPath = path.join(REPO_ROOT, "corp-swarm.config.local.json");
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (fs.existsSync(localPath)) {
    Object.assign(raw, JSON.parse(fs.readFileSync(localPath, "utf8")));
  }
  return SwarmConfigSchema.parse(raw);
}

/** Persist overrides that should survive restarts (target repo, github source, etc.). */
export function saveLocalConfig(patch: Partial<SwarmConfig>): SwarmConfig {
  const localPath = path.join(REPO_ROOT, "corp-swarm.config.local.json");
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(localPath)) {
    existing = JSON.parse(fs.readFileSync(localPath, "utf8")) as Record<
      string,
      unknown
    >;
  }
  const next = { ...existing, ...patch };
  fs.writeFileSync(localPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  return loadConfig();
}

export function dataDir(): string {
  const dir = path.join(REPO_ROOT, "data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
