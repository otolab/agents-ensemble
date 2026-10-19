import { describe, expect, it } from 'vitest';
import {
  isOperatorCommand,
  OPERATOR_COMMANDS,
} from './operator-command.js';

describe('operator command catalog', () => {
  it('contains only the registered slash commands and their existing aliases', () => {
    expect(
      OPERATOR_COMMANDS.map(({ name, aliases }) => ({ name, aliases })),
    ).toEqual([
      { name: '/reconnect', aliases: ['reconnect'] },
      { name: '/exit', aliases: ['exit'] },
      { name: '/close', aliases: ['close'] },
    ]);
  });

  it('uses the catalog for case-insensitive exact command matching', () => {
    for (const command of OPERATOR_COMMANDS) {
      expect(isOperatorCommand(command.name, command.id)).toBe(true);
      expect(isOperatorCommand(` ${command.aliases[0]?.toUpperCase()} `, command.id)).toBe(
        true,
      );
      expect(isOperatorCommand(`${command.name} extra`, command.id)).toBe(false);
    }
  });
});
