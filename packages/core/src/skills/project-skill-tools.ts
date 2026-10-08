import type { ConductorToolSet } from '../conductor/conductor-tool.js';
import { yamlToolResult } from '../dispatch/yaml-tool-result.js';
import type { ProjectSkillCatalog, ProjectSkillCatalogEntry } from './project-skill-catalog.js';

export interface ProjectSkillToolOptions {
  catalog: ProjectSkillCatalog;
}

export function createProjectSkillTools(
  options: ProjectSkillToolOptions,
): ConductorToolSet {
  const { catalog } = options;

  return {
    list_project_skills: {
      name: 'list_project_skills',
      description:
        'List project skill documents discovered under repo roots (.agents/skills, .claude/skills, .cursor/skills, .codex/skills, .ensemble/pi/skills, etc.). Names are deduplicated; higher-priority roots win. Use before dispatching workers when you need to know which playbooks exist.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      async execute() {
        const items = await catalog.load();
        const summary = {
          repoRoot: catalog.repoRoot,
          rootsScanned: catalog.rootsScanned,
          count: items.length,
          skills: items.map(summarizeListItem),
        };
        return yamlToolResult('list_project_skills', summary);
      },
    },
    search_project_skills: {
      name: 'search_project_skills',
      description:
        'Search project skills by substring in name or description (case-insensitive). Returns the same deduplicated catalog entries as list_project_skills.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Substring to match against skill name or description',
          },
        },
        required: ['query'],
      },
      async execute(args) {
        const query = String(args.query ?? '');
        const items = await catalog.search(query);
        return yamlToolResult('search_project_skills', {
          query: query.trim(),
          count: items.length,
          skills: items.map(summarizeListItem),
        });
      },
    },
    get_project_skill: {
      name: 'get_project_skill',
      description:
        'Read one project skill by name (SKILL.md body). Use after list_project_skills or search_project_skills. Includes shadowed duplicate locations when present.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Skill name from frontmatter or directory name',
          },
        },
        required: ['name'],
      },
      async execute(args) {
        const name = String(args.name ?? '').trim();
        if (!name) {
          throw new Error('get_project_skill requires name');
        }
        const entry = await catalog.getByName(name);
        if (!entry) {
          throw new Error(`get_project_skill: not found: ${name}`);
        }
        return yamlToolResult('get_project_skill', serializeDetail(entry));
      },
    },
  };
}

function summarizeListItem(entry: ProjectSkillCatalogEntry) {
  return {
    name: entry.name,
    description: entry.description,
    source: entry.source,
    root: entry.root,
    filePath: entry.filePath,
    disableModelInvocation: entry.disableModelInvocation,
    shadowCount: entry.shadows.length,
  };
}

function serializeDetail(entry: ProjectSkillCatalogEntry) {
  return {
    name: entry.name,
    description: entry.description,
    source: entry.source,
    root: entry.root,
    filePath: entry.filePath,
    disableModelInvocation: entry.disableModelInvocation,
    shadows: entry.shadows,
    content: entry.content,
  };
}
