/**
 * The headless Pi conductor's settings contract.
 *
 * Keep this table as the code-level source of truth for which settings are
 * consumed by the conductor and through which channel. Unknown settings are
 * intentionally ignored. In particular, this table is also used to build the
 * only settings object handed to Pi's SettingsManager.
 */
export const PI_HEADLESS_SETTING_DEFINITIONS = [
  { key: 'defaultProvider', channel: 'model-selection', match: 'exact' },
  { key: 'defaultModel', channel: 'model-selection', match: 'exact' },
  { key: 'model', channel: 'model-selection', match: 'exact' },
  { key: 'modelId', channel: 'model-selection', match: 'exact' },
  { key: 'apiKey', channel: 'auth-fallback', match: 'exact' },
  { key: 'apiKeys', channel: 'auth-fallback', match: 'exact' },
  { key: 'extensions', channel: 'resource-path', match: 'exact' },
  { key: 'skills', channel: 'resource-path', match: 'exact' },
  { key: 'prompts', channel: 'resource-path', match: 'exact' },
  { key: 'themes', channel: 'resource-path', match: 'exact' },
  {
    key: 'compaction',
    channel: 'settings-manager-override',
    match: 'exact',
    nestedKeys: ['enabled', 'reserveTokens', 'keepRecentTokens', 'modelOverrides'],
  },
  {
    key: 'branchSummary',
    channel: 'settings-manager-override',
    match: 'exact',
    nestedKeys: ['reserveTokens', 'skipPrompt'],
  },
  { key: 'defaultThinkingLevel', channel: 'ignored', match: 'exact' },
  { key: 'modelThinkingLevels', channel: 'ignored', match: 'exact' },
  { key: 'thinkingBudgets', channel: 'ignored', match: 'exact' },
  { key: 'enabledModels', channel: 'ignored', match: 'exact' },
  { key: 'hideThinkingBlock', channel: 'ignored', match: 'exact' },
  { key: 'showCacheMissNotices', channel: 'ignored', match: 'exact' },
  { key: 'cacheWarming', channel: 'ignored', match: 'exact' },
  { key: 'steeringMode', channel: 'ignored', match: 'exact' },
  { key: 'followUpMode', channel: 'ignored', match: 'exact' },
  { key: 'defaultTools', channel: 'ignored', match: 'exact' },
  { key: 'codemode', channel: 'ignored', match: 'prefix' },
  { key: 'packages', channel: 'ignored', match: 'exact' },
  { key: 'enableSkillCommands', channel: 'ignored', match: 'exact' },
  { key: 'sessionDir', channel: 'ignored', match: 'exact' },
  { key: 'theme', channel: 'ignored', match: 'exact' },
  { key: 'quietStartup', channel: 'ignored', match: 'exact' },
  { key: 'tuiMode', channel: 'ignored', match: 'exact' },
  { key: 'fullscreen', channel: 'ignored', match: 'prefix' },
  { key: 'terminal', channel: 'ignored', match: 'prefix' },
  { key: 'images', channel: 'ignored', match: 'prefix' },
  { key: 'markdown', channel: 'ignored', match: 'prefix' },
  { key: 'transport', channel: 'ignored', match: 'exact' },
  { key: 'httpProxy', channel: 'ignored', match: 'exact' },
  { key: 'httpIdleTimeoutMs', channel: 'ignored', match: 'exact' },
  { key: 'websocketConnectTimeoutMs', channel: 'ignored', match: 'exact' },
  { key: 'retry', channel: 'ignored', match: 'prefix' },
  { key: 'shellPath', channel: 'ignored', match: 'exact' },
  { key: 'shellCommandPrefix', channel: 'ignored', match: 'exact' },
  { key: 'npmCommand', channel: 'ignored', match: 'exact' },
  { key: 'collapseChangelog', channel: 'ignored', match: 'exact' },
  { key: 'enableInstallTelemetry', channel: 'ignored', match: 'exact' },
  { key: 'enableAnalytics', channel: 'ignored', match: 'exact' },
  { key: 'warnings', channel: 'ignored', match: 'prefix' },
] as const;

export type PiHeadlessSettingsChannel = (typeof PI_HEADLESS_SETTING_DEFINITIONS)[number]['channel'];
export type PiHeadlessSettingsManagerOverrides = Record<string, unknown>;

/** Read a setting only when its channel is declared by the headless contract. */
export function getPiHeadlessSetting(
  settings: Record<string, unknown>,
  key: string,
  channel: PiHeadlessSettingsChannel,
): unknown {
  const definition = PI_HEADLESS_SETTING_DEFINITIONS.find(
    (candidate) =>
      candidate.match === 'prefix'
        ? key.startsWith(candidate.key)
        : candidate.key === key,
  );
  if (!definition) {
    throw new Error(`Pi headless setting "${key}" is not declared in the settings contract.`);
  }
  if (definition.channel !== channel) return undefined;
  return settings[key];
}

/** Return the Pi SettingsManager payload allowed by the headless contract. */
export function getPiHeadlessSettingsManagerOverrides(
  settings: Record<string, unknown>,
): PiHeadlessSettingsManagerOverrides {
  const overrides: PiHeadlessSettingsManagerOverrides = {};
  for (const definition of PI_HEADLESS_SETTING_DEFINITIONS) {
    if (definition.channel !== 'settings-manager-override') continue;
    const value = settings[definition.key];
    if (!isRecord(value)) continue;

    const filtered = pickRecord(value, definition.nestedKeys);
    if (definition.key === 'compaction' && isRecord(filtered.modelOverrides)) {
      filtered.modelOverrides = Object.fromEntries(
        Object.entries(filtered.modelOverrides).flatMap(([modelId, modelOverride]) => {
          if (!isRecord(modelOverride)) return [];
          return [[modelId, pickRecord(modelOverride, ['reserveTokens', 'keepRecentTokens'])]];
        }),
      );
    }
    overrides[definition.key] = filtered;
  }
  return overrides;
}

function pickRecord(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    keys.flatMap((key) => (value[key] === undefined ? [] : [[key, value[key]]] as const)),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Pi SettingsManager overrides needed for Pi standard skill discovery. */
export function getPiSkillsDiscoverySettingsOverrides(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const skills = settings.skills;
  if (!Array.isArray(skills)) return {};
  const paths = skills.filter((entry): entry is string => typeof entry === 'string');
  return paths.length > 0 ? { skills: paths } : {};
}
