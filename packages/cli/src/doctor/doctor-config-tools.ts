import {
  DOCTOR_CONFIG_SETTING_PATHS,
  readDoctorConfigSettings,
  writeDoctorConfigSetting,
  type ConductorJsonValue,
  type ConductorTool,
  type ConductorToolResult,
  type ConductorToolSet,
  type DoctorConfigLayer,
  type DoctorConfigSettingKey,
  type DoctorConfigSettingValue,
  type DoctorConfigWriteProposal,
} from '@agents-ensemble/core';

export interface CreateDoctorConfigToolsOptions {
  repoRoot: string;
  target: DoctorConfigLayer;
  userEnsembleRoot?: string;
  confirm: (proposal: DoctorConfigWriteProposal) => Promise<boolean>;
}

export interface CreateDoctorReadConfigToolOptions {
  repoRoot: string;
  userEnsembleRoot?: string;
}

const CONFIG_KEYS = Object.keys(
  DOCTOR_CONFIG_SETTING_PATHS,
) as DoctorConfigSettingKey[];
const CONFIG_VALUES: ConductorJsonValue[] = [
  'cursor',
  'claude',
  'codex',
  'pi',
  'isolated',
  'in_repo',
  true,
  false,
];

export function createDoctorConfigTools(
  options: CreateDoctorConfigToolsOptions,
): ConductorToolSet {
  const readTool = createDoctorReadConfigTool(options);
  const writeTool: ConductorTool = {
    name: 'doctor_write_config',
    description:
      'Propose one allowlisted config change. The operator must approve it in the TTY before it is written.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', enum: CONFIG_KEYS },
        value: { enum: CONFIG_VALUES },
      },
      required: ['key', 'value'],
      additionalProperties: false,
    },
    execute: async (args) => {
      if (
        Object.keys(args).some((key) => key !== 'key' && key !== 'value') ||
        typeof args.key !== 'string' ||
        !CONFIG_KEYS.includes(args.key as DoctorConfigSettingKey)
      ) {
        return toolError('Unsupported doctor setting proposal.');
      }

      try {
        const result = await writeDoctorConfigSetting({
          repoRoot: options.repoRoot,
          ...(options.userEnsembleRoot
            ? { userEnsembleRoot: options.userEnsembleRoot }
            : {}),
          key: args.key as DoctorConfigSettingKey,
          value: args.value as DoctorConfigSettingValue,
          target: options.target,
          confirm: options.confirm,
        });
        if (!result.written) {
          return toolSuccess('Operator declined; the config was not changed.');
        }
        return {
          content: [
            {
              type: 'text',
              text: `Saved ${result.key} to the ${result.target} config.`,
            },
          ],
          structuredContent: {
            written: true,
            key: result.key,
            value: result.value,
            target: result.target,
          },
        };
      } catch {
        return toolError(
          'The proposed setting could not be written safely. No other file or config key was changed.',
        );
      }
    },
  };

  return {
    doctor_read_config: readTool,
    doctor_write_config: writeTool,
  };
}

/** Create the read-only allowlisted config tool used by diagnostic agents. */
export function createDoctorReadConfigTool(
  options: CreateDoctorReadConfigToolOptions,
): ConductorTool {
  return {
    name: 'doctor_read_config',
    description:
      'Read the effective values and source for the non-secret doctor config allowlist.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    execute: async (args) => {
      if (Object.keys(args).length > 0) {
        return toolError('This tool does not accept arguments.');
      }
      try {
        const snapshot = await readDoctorConfigSettings({
          repoRoot: options.repoRoot,
          ...(options.userEnsembleRoot
            ? { userEnsembleRoot: options.userEnsembleRoot }
            : {}),
        });
        const settings = snapshot.settings.map(({ key, value, source }) => ({
          key,
          value,
          source,
        }));
        return {
          content: [
            {
              type: 'text',
              text: settings
                .map(({ key, value, source }) => `${key}: ${value} (source: ${source})`)
                .join('\n'),
            },
          ],
          structuredContent: { settings },
        };
      } catch {
        return toolError(
          'Could not read the allowlisted settings. No config values were returned.',
        );
      }
    },
  };
}

function toolSuccess(text: string): ConductorToolResult {
  return { content: [{ type: 'text', text }] };
}

function toolError(text: string): ConductorToolResult {
  return { content: [{ type: 'text', text: `Error: ${text}` }] };
}
