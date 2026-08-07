import type {
  CompiledPrompt,
  Element,
  SubSectionElement,
} from '@modular-prompt/core';

/** CompiledPrompt を ACP 起動用のプレーンテキストに変換する。 */
export function renderCompiledPrompt(compiled: CompiledPrompt): string {
  const blocks: string[] = [];

  for (const category of ['instructions', 'data', 'output'] as const) {
    for (const element of compiled[category]) {
      const rendered = renderElement(element);
      if (rendered) blocks.push(rendered);
    }
  }

  return blocks.join('\n\n').trim();
}

function renderElement(element: Element): string {
  if (element.type === 'section') {
    const body = element.items
      .map((item) => {
        if (typeof item === 'string') return item;
        if ('type' in item && item.type === 'subsection') {
          return renderSubSection(item);
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');

    if (!body) return '';
    return `## ${element.title}\n\n${body}`;
  }

  if (element.type === 'text') {
    return element.content;
  }

  if (element.type === 'message' && element.role !== 'tool') {
    return typeof element.content === 'string' ? element.content : '';
  }

  return '';
}

function renderSubSection(subsection: SubSectionElement): string {
  const body = subsection.items.filter(Boolean).join('\n');
  if (!body) return '';
  return `### ${subsection.title}\n\n${body}`;
}
