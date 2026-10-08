import { join } from 'node:path';
import { discoverSkillFiles, readSkillMarkdown } from './skill-markdown.js';

/** Project-relative roots scanned for SKILL.md (higher priority wins on name collision). */
export const PROJECT_SKILL_ROOT_SPECS = [
  { source: 'codex', relativePath: '.codex/skills', priority: 10 },
  { source: 'claude', relativePath: '.claude/skills', priority: 20 },
  { source: 'cursor', relativePath: '.cursor/skills-cursor', priority: 30 },
  { source: 'cursor', relativePath: '.cursor/skills', priority: 40 },
  { source: 'ensemble-pi', relativePath: '.ensemble/pi/skills', priority: 50 },
  { source: 'agents', relativePath: '.agents/skill', priority: 60 },
  { source: 'agents', relativePath: '.agents/skills', priority: 70 },
] as const;

export interface ProjectSkillShadow {
  source: string;
  root: string;
  filePath: string;
  priority: number;
}

export interface ProjectSkillCatalogEntry {
  name: string;
  description: string;
  filePath: string;
  content: string;
  source: string;
  root: string;
  priority: number;
  disableModelInvocation: boolean;
  shadows: ProjectSkillShadow[];
}

export interface ProjectSkillCatalog {
  repoRoot: string;
  rootsScanned: string[];
  load(): Promise<ProjectSkillCatalogEntry[]>;
  getByName(name: string): Promise<ProjectSkillCatalogEntry | undefined>;
  search(query: string): Promise<ProjectSkillCatalogEntry[]>;
}

export function createProjectSkillCatalog(repoRoot: string): ProjectSkillCatalog {
  const rootsScanned = PROJECT_SKILL_ROOT_SPECS.map((spec) =>
    join(repoRoot, spec.relativePath),
  );

  async function load(): Promise<ProjectSkillCatalogEntry[]> {
    const byName = new Map<string, ProjectSkillCatalogEntry>();

    const specs = [...PROJECT_SKILL_ROOT_SPECS].sort((left, right) => left.priority - right.priority);
    for (const spec of specs) {
      const rootPath = join(repoRoot, spec.relativePath);
      for (const filePath of await discoverSkillFiles(rootPath)) {
        const skill = await readSkillMarkdown(filePath);
        if (!skill) continue;

        const incoming: ProjectSkillCatalogEntry = {
          name: skill.name,
          description: skill.description,
          filePath: skill.filePath,
          content: skill.content,
          source: spec.source,
          root: spec.relativePath,
          priority: spec.priority,
          disableModelInvocation: skill.disableModelInvocation,
          shadows: [],
        };

        const existing = byName.get(skill.name);
        if (!existing) {
          byName.set(skill.name, incoming);
          continue;
        }

        if (incoming.priority > existing.priority) {
          incoming.shadows = [
            ...existing.shadows,
            {
              source: existing.source,
              root: existing.root,
              filePath: existing.filePath,
              priority: existing.priority,
            },
          ];
          byName.set(skill.name, incoming);
        } else {
          existing.shadows.push({
            source: incoming.source,
            root: incoming.root,
            filePath: incoming.filePath,
            priority: incoming.priority,
          });
        }
      }
    }

    return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  return {
    repoRoot,
    rootsScanned,
    load,
    async getByName(name: string) {
      const trimmed = name.trim();
      if (!trimmed) return undefined;
      const items = await load();
      return items.find((entry) => entry.name === trimmed);
    },
    async search(query: string) {
      const normalized = query.trim().toLowerCase();
      if (!normalized) return await load();
      const items = await load();
      return items.filter((entry) => {
        const haystack = `${entry.name}\n${entry.description}`.toLowerCase();
        return haystack.includes(normalized);
      });
    },
  };
}
