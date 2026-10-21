import { describe, expect, it } from 'vitest';
import {
  isOperatorCommand,
  OPERATOR_COMMANDS,
  parseOperatorMessageDelivery,
} from './operator-command.js';

describe('operator command catalog', () => {
  it('contains only the registered slash commands and their existing aliases', () => {
    expect(
      OPERATOR_COMMANDS.map(({ name, aliases }) => ({ name, aliases })),
    ).toEqual([
      { name: '/idle', aliases: [] },
      { name: '/next', aliases: [] },
      { name: '/interrupt', aliases: [] },
      { name: '/reconnect', aliases: ['reconnect'] },
      { name: '/exit', aliases: ['exit'] },
      { name: '/close', aliases: ['close'] },
    ]);
  });

  it('uses the catalog for case-insensitive exact command matching', () => {
    for (const command of OPERATOR_COMMANDS) {
      expect(isOperatorCommand(command.name, command.id)).toBe(true);
      for (const alias of command.aliases) {
        expect(isOperatorCommand(` ${alias.toUpperCase()} `, command.id)).toBe(
          true,
        );
      }
      expect(isOperatorCommand(`${command.name} extra`, command.id)).toBe(false);
    }
  });

  it('parses delivery prefixes and defaults ordinary input to next', () => {
    expect(parseOperatorMessageDelivery('/idle keep going')).toEqual({
      message: 'keep going',
      delivery: 'idle',
    });
    expect(parseOperatorMessageDelivery('/INTERRUPT stop')).toEqual({
      message: 'stop',
      delivery: 'interrupt',
    });
    expect(parseOperatorMessageDelivery('/next now')).toEqual({
      message: 'now',
      delivery: 'next',
    });
    expect(parseOperatorMessageDelivery('ordinary message')).toEqual({
      message: 'ordinary message',
      delivery: 'next',
    });
    expect(parseOperatorMessageDelivery('/idle')).toEqual({
      message: '',
      delivery: 'idle',
    });
  });
});
