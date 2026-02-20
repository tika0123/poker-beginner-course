import { execSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type Options = {
  markdownPath: string;
  jsonDir: string;
};

const DEFAULTS: Options = {
  markdownPath: "preflop_training.md",
  jsonDir: "drills",
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repo = getRepoNameFromOrigin();
  const branch = getCurrentBranch();
  const jsonFiles = await listJsonFiles(options.jsonDir);
  const original = await readFile(options.markdownPath, "utf8");
  const updated = updateRoadmapLinks(
    original,
    repo,
    branch,
    options.jsonDir,
    jsonFiles,
  );

  if (original === updated) {
    console.log("No changes.");
    return;
  }

  await writeFile(options.markdownPath, updated, "utf8");
  console.log(`Updated ${options.markdownPath}`);
}

function parseArgs(args: string[]): Options {
  const options = { ...DEFAULTS };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === "--markdown" && next) {
      options.markdownPath = next;
      i += 1;
      continue;
    }
    if (arg === "--json-dir" && next) {
      options.jsonDir = next;
      i += 1;
      continue;
    }

    throw new Error(`Unknown or incomplete argument: ${arg}`);
  }

  return options;
}

function getRepoNameFromOrigin(): string {
  const remoteUrl = exec("git remote get-url origin").trim();

  const httpsMatch = remoteUrl.match(
    /^https:\/\/github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/,
  );
  if (httpsMatch?.[1]) {
    return httpsMatch[1];
  }

  const sshMatch = remoteUrl.match(
    /^git@github\.com:([^/]+\/[^/.]+)(?:\.git)?$/,
  );
  if (sshMatch?.[1]) {
    return sshMatch[1];
  }

  throw new Error(`Unsupported origin URL format: ${remoteUrl}`);
}

function getCurrentBranch(): string {
  const branch = exec("git branch --show-current").trim();
  if (branch.length > 0) {
    return branch;
  }
  return "main";
}

function exec(cmd: string): string {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function listJsonFiles(rootDir: string): Promise<string[]> {
  return walk(rootDir, rootDir);
}

async function walk(rootDir: string, currentDir: string): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await walk(rootDir, absPath);
      files.push(...nested);
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) {
      continue;
    }

    const relPath = path.relative(rootDir, absPath).split(path.sep).join("/");
    files.push(relPath);
  }

  return files.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

function updateRoadmapLinks(
  markdown: string,
  repo: string,
  branch: string,
  jsonDir: string,
  relativeJsonFiles: string[],
): string {
  const rows = relativeJsonFiles.map((relFile) => {
    const fileName = relFile.split("/").at(-1) ?? relFile;
    const label = fileName.replace(/\.json$/i, "");
    const repoPath = path.posix.join(toPosixPath(jsonDir), relFile);
    const url = `https://github.com/${repo}/blob/${branch}/${buildBlobPath(repoPath)}`;
    return { label, url };
  });

  const lines = markdown.split("\n");

  for (const row of rows) {
    const matchIndex = lines.findIndex((line) => isTargetLine(line, row.label));
    if (matchIndex === -1) {
      continue;
    }
    lines[matchIndex] = upsertLinkSuffix(lines[matchIndex], row.url);
  }

  return lines.join("\n");
}

function buildBlobPath(relPath: string): string {
  return relPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function toPosixPath(p: string): string {
  return p.split(path.sep).join("/");
}

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function lineMatchesLabel(line: string, label: string): boolean {
  const normalizedLine = normalizeSpaces(line);
  const normalizedLabel = normalizeSpaces(label);
  return normalizedLine.includes(normalizedLabel);
}

function isTargetLine(line: string, label: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed.startsWith("<!--")) {
    return false;
  }
  if (trimmed.startsWith(">")) {
    return false;
  }
  if (trimmed.includes("](")) {
    return false;
  }
  return lineMatchesLabel(line, label);
}

function upsertLinkSuffix(line: string, url: string): string {
  const suffixRegexes = [
    /\s*[（(]\s*\[download\]\((?:<[^>]+>|[^)]+)\)\s*[)）]\s*$/i,
    /\s*[（(]\s*\[link\]\((?:<[^>]+>|[^)]+)\)\s*[)）]\s*$/i,
    /\s*[（(]\s*download\s*[)）]\s*$/i,
    /\s*[（(]\s*link\s*[)）]\s*$/i,
  ];

  let base = line;
  for (const regex of suffixRegexes) {
    base = base.replace(regex, "");
  }

  return `${base} ([link](<${url}>))`;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
