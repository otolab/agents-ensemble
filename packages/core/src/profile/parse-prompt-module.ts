import type { PromptModule, SubSectionElement } from '@modular-prompt/core';
import { STANDARD_SECTIONS } from '@modular-prompt/core';

const PROMPT_SECTION_NAMES = Object.keys(STANDARD_SECTIONS) as Array<
  keyof typeof STANDARD_SECTIONS
>;

const SUBSECTION_TYPE = 'subsection';

type PromptSectionContent = (string | SubSectionElement)[];

function isSubSection(value: unknown): value is SubSectionElement {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const subsection = value as SubSectionElement;
  return (
    subsection.type === SUBSECTION_TYPE &&
    typeof subsection.title === 'string' &&
    Array.isArray(subsection.items)
  );
}

function parseSectionItems(
  items: unknown[],
  label: string,
  sectionName: string,
): PromptSectionContent {
  return items.map((item, index) => {
    if (typeof item === 'string') {
      return item;
    }
    if (isSubSection(item)) {
      const parsedItems = item.items.map((entry, entryIndex) => {
        if (typeof entry !== 'string') {
          throw new Error(
            `Invalid profile prompt in ${label}: ${sectionName}[${index}].items[${entryIndex}] must be a string`,
          );
        }
        return entry;
      });
      return {
        type: SUBSECTION_TYPE,
        title: item.title,
        items: parsedItems,
      };
    }
    throw new Error(
      `Invalid profile prompt in ${label}: ${sectionName}[${index}] must be a string or subsection`,
    );
  });
}

/** profile の modular-prompt YAML を静的 `PromptModule` に変換する（DynamicContent 不可）。 */
export function parsePromptModuleFromYaml(source: unknown, label: string): PromptModule {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(`Invalid profile prompt in ${label}: expected YAML object`);
  }

  const raw = source as Record<string, unknown>;
  const module: Record<string, PromptSectionContent> = {};

  for (const key of Object.keys(raw)) {
    if (!PROMPT_SECTION_NAMES.includes(key as keyof typeof STANDARD_SECTIONS)) {
      throw new Error(
        `Invalid profile prompt in ${label}: unknown section "${key}"`,
      );
    }
    const value = raw[key];
    if (!Array.isArray(value)) {
      throw new Error(
        `Invalid profile prompt in ${label}: section "${key}" must be an array`,
      );
    }
    module[key] = parseSectionItems(value, label, key);
  }

  if (Object.keys(module).length === 0) {
    throw new Error(`Invalid profile prompt in ${label}: prompt is empty`);
  }

  return module;
}
