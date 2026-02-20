import { execSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type Options = {
  markdownPath: string;
  jsonDir: string;
};

type DrillEntry = {
  relPath: string;
  order: number | null;
  name: string;
  description: string;
  url: string;
};

const DEFAULTS: Options = {
  markdownPath: "preflop_training.md",
  jsonDir: "drills",
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repo = getRepoNameFromOrigin();
  const branch = getCurrentBranch();
  const relativeJsonFiles = await listJsonFiles(options.jsonDir);
  const drills = await buildDrillEntries(
    options.jsonDir,
    relativeJsonFiles,
    repo,
    branch,
  );
  const original = await readFile(options.markdownPath, "utf8");
  const updated = updateRoadmapSection(original, drills);

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

  return files;
}

async function buildDrillEntries(
  jsonDir: string,
  relativeJsonFiles: string[],
  repo: string,
  branch: string,
): Promise<DrillEntry[]> {
  const entries = await Promise.all(
    relativeJsonFiles.map(async (relPath) => {
      const absPath = path.join(jsonDir, relPath);
      const parsed = await parseDrillJson(absPath, relPath);
      const repoPath = path.posix.join(toPosixPath(jsonDir), relPath);
      const url = `https://github.com/${repo}/blob/${branch}/${buildBlobPath(repoPath)}`;

      return {
        relPath,
        order: getOrderFromFileName(relPath),
        name: parsed.name,
        description: parsed.description,
        url,
      } satisfies DrillEntry;
    }),
  );

  return entries.sort(compareDrills);
}

async function parseDrillJson(
  absPath: string,
  relPath: string,
): Promise<{ name: string; description: string }> {
  let raw: string;
  try {
    raw = await readFile(absPath, "utf8");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read JSON: ${relPath} (${message})`);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON: ${relPath} (${message})`);
  }

  if (typeof data !== "object" || data === null) {
    throw new Error(`Invalid drill JSON object: ${relPath}`);
  }

  const record = data as Record<string, unknown>;
  const name = record.name;
  const description = record.description;

  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error(`Missing or invalid 'name': ${relPath}`);
  }
  if (typeof description !== "string" || description.trim().length === 0) {
    throw new Error(`Missing or invalid 'description': ${relPath}`);
  }

  return { name, description };
}

function compareDrills(a: DrillEntry, b: DrillEntry): number {
  if (a.order !== null && b.order !== null && a.order !== b.order) {
    return a.order - b.order;
  }
  if (a.order !== null && b.order === null) {
    return -1;
  }
  if (a.order === null && b.order !== null) {
    return 1;
  }
  return a.relPath.localeCompare(b.relPath, "en", { numeric: true });
}

function getOrderFromFileName(relPath: string): number | null {
  const fileName = relPath.split("/").at(-1) ?? relPath;
  const match = fileName.match(/^(\d+)/);
  if (!match?.[1]) {
    return null;
  }

  const value = Number.parseInt(match[1], 10);
  return Number.isNaN(value) ? null : value;
}

function updateRoadmapSection(markdown: string, drills: DrillEntry[]): string {
  const lines = markdown.split("\n");
  const headingIndex = lines.findIndex((line) =>
    line.trim().startsWith("## ロードマップ"),
  );

  if (headingIndex === -1) {
    throw new Error("Could not find '## ロードマップ' section.");
  }

  const nextHeadingIndex = findNextH2(lines, headingIndex + 1);
  const sectionEnd = nextHeadingIndex === -1 ? lines.length : nextHeadingIndex;
  const roadmapBody = lines.slice(headingIndex + 1, sectionEnd);

  const preservedPrefix = getPreservedRoadmapPrefix(roadmapBody);
  const generated = renderRoadmapItems(drills);
  const nextBody =
    generated.length === 0
      ? preservedPrefix
      : [...preservedPrefix, "", ...generated, ""];

  return [
    ...lines.slice(0, headingIndex + 1),
    ...nextBody,
    ...lines.slice(sectionEnd),
  ].join("\n");
}

function findNextH2(lines: string[], from: number): number {
  for (let i = from; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith("## ")) {
      return i;
    }
  }
  return -1;
}

function getPreservedRoadmapPrefix(roadmapBody: string[]): string[] {
  let quoteCount = 0;
  for (let i = 0; i < roadmapBody.length; i += 1) {
    if (roadmapBody[i].trimStart().startsWith(">")) {
      quoteCount += 1;
      if (quoteCount === 2) {
        return roadmapBody.slice(0, i + 1);
      }
    }
  }

  throw new Error("Roadmap section must contain two quote lines to preserve.");
}

function renderRoadmapItems(drills: DrillEntry[]): string[] {
  const lines: string[] = [];

  drills.forEach((drill, index) => {
    const cleanName = stripLeadingNumber(drill.name);
    lines.push(`${index + 1}.  **${cleanName}** ([link](<${drill.url}>))`);
    lines.push("");
    for (const row of drill.description.split("\n")) {
      lines.push(`    ${row}`);
    }

    if (index < drills.length - 1) {
      lines.push("");
      lines.push("<br>");
      lines.push("");
    }
  });

  return lines;
}

function stripLeadingNumber(value: string): string {
  return value.replace(/^\d+\.\s*/, "");
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

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
