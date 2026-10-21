import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ENSEMBLE_DIR } from '../profile/profile-paths.js';
import type { ResolvedProfileMaterial } from '../profile/types.js';

export const USER_INSTRUCTIONS_FILE = 'AGENTS.md';

export interface LoadUserInstructionsOptions {
  /** テスト用。既定は `~/.ensemble`。 */
  userEnsembleRoot?: string;
}

/**
 * `~/.ensemble/AGENTS.md` を conductor と worker 用 Prepared Material として読む。
 * ファイルが無い場合は何も追加しない。存在するが読めない場合は起動を失敗させる。
 */
export async function loadUserInstructions(
  options: LoadUserInstructionsOptions = {},
): Promise<ResolvedProfileMaterial | undefined> {
  const root = options.userEnsembleRoot ?? join(homedir(), ENSEMBLE_DIR);
  const path = join(root, USER_INSTRUCTIONS_FILE);
  let content: string;

  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return undefined;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read user instructions at ${path}: ${detail}`, {
      cause: error,
    });
  }

  const trimmed = content.trim();
  if (!trimmed) {
    return undefined;
  }

  return {
    id: 'user-instructions',
    title: 'User instructions (~/.ensemble/AGENTS.md)',
    content: trimmed,
  };
}
