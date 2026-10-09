import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

export interface SkillMarkdownResource {
  name: string;
  description: string;
  filePath: string;
  content: string;
  disableModelInvocation: boolean;
}

interface ParsedMarkdownResource {
  frontmatter: Record<string, string | boolean>;
  body: string;
}

export function parseMarkdownResource(source: string): ParsedMarkdownResource {
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { frontmatter: {}, body: source.trim() };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) return { frontmatter: {}, body: source.trim() };

  const frontmatter: Record<string, string | boolean> = {};
  for (const line of lines.slice(1, end)) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (!key) continue;
    if (rawValue === 'true' || rawValue === 'false') {
      frontmatter[key] = rawValue === 'true';
    } else {
      frontmatter[key] = unquote(rawValue);
    }
  }
  return {
    frontmatter,
    body: lines.slice(end + 1).join('\n').trim(),
  };
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function firstNonEmptyLine(value: string): string | undefined {
  return value.split(/\r?\n/).find((line) => line.trim())?.trim();
}

export async function discoverSkillFiles(path: string): Promise<string[]> {
  const directFile = await readableFile(path);
  if (directFile && extname(path).toLowerCase() === '.md') return [path];

  const entries = await readDirectory(path);
  if (entries.length === 0) return [];
  const skillFile = join(path, 'SKILL.md');
  if (await readableFile(skillFile)) return [skillFile];

  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('.')) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await discoverSkillFiles(child)));
    } else if (extname(entry.name).toLowerCase() === '.md') {
      files.push(child);
    }
  }
  return files;
}

export async function readSkillMarkdown(
  path: string,
): Promise<SkillMarkdownResource | undefined> {
  const source = await readOptionalText(path);
  if (source === undefined) return undefined;
  const parsed = parseMarkdownResource(source);
  const name = stringValue(parsed.frontmatter.name) ?? basename(dirname(path));
  const description =
    stringValue(parsed.frontmatter.description) ?? firstNonEmptyLine(parsed.body) ?? name;
  return {
    name,
    description,
    filePath: path,
    content: parsed.body,
    disableModelInvocation: parsed.frontmatter['disable-model-invocation'] === true,
  };
}

async function readableFile(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function readDirectory(
  directory: string,
): Promise<Array<{ name: string; isDirectory: () => boolean }>> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}
