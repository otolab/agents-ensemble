export interface ModelsListEntry {
  id: string;
  displayName: string;
  description?: string;
  aliases?: string[];
}

export function formatModelsListText(models: ModelsListEntry[]): string {
  if (models.length === 0) {
    return '（利用可能なモデルはありません）';
  }

  const idWidth = Math.max(2, ...models.map((model) => model.id.length));
  const lines = models.map(
    (model) => `${model.id.padEnd(idWidth)}  ${model.displayName}`,
  );
  return lines.join('\n');
}

export function formatModelsListJson(models: ModelsListEntry[]): string {
  return JSON.stringify(
    models.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      ...(model.description ? { description: model.description } : {}),
      ...(model.aliases?.length ? { aliases: model.aliases } : {}),
    })),
    null,
    2,
  );
}
