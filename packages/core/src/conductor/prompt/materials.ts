import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ConductorMaterial } from './types.js';

export interface LoadConductorMaterialOptions {
  id?: string;
  title?: string;
}

export async function loadConductorMaterialFromFile(
  filePath: string,
  options: LoadConductorMaterialOptions = {},
): Promise<ConductorMaterial> {
  const content = await readFile(filePath, 'utf8');
  const fileName = basename(filePath);

  return {
    id: options.id ?? fileName,
    title: options.title ?? fileName,
    content,
  };
}

export function mergeConductorMaterials(
  materials: ConductorMaterial[] | undefined,
  briefing: string | undefined,
): ConductorMaterial[] {
  const merged = [...(materials ?? [])];

  if (briefing?.trim()) {
    merged.push({
      id: 'briefing',
      title: '作業基準メモ',
      content: briefing.trim(),
    });
  }

  return merged;
}
