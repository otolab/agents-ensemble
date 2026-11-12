import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { ensureBuiltinPiConfig } from '../../src/acp/builtin-config.js'

describe('ensureBuiltinPiConfig', () => {
  let tempRoot = ''

  afterEach(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
    tempRoot = ''
  })

  it('copies the packaged settings when the user has no settings file', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'builtin-pi-config-'))
    const agentDir = join(tempRoot, 'pi')
    const defaultsPath = join(tempRoot, 'defaults.json')
    const bundledSettings = '{"defaultThinkingLevel":"medium"}\n'
    await writeFile(defaultsPath, bundledSettings)

    ensureBuiltinPiConfig({ agentDir, defaultsPath })

    assert.equal(
      await readFile(join(agentDir, 'settings.json'), 'utf8'),
      bundledSettings,
    )
  })

  it('preserves existing user settings', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'builtin-pi-config-'))
    const agentDir = join(tempRoot, 'pi')
    const defaultsPath = join(tempRoot, 'defaults.json')
    const userSettings = '{"defaultThinkingLevel":"high"}\n'
    await writeFile(defaultsPath, '{"defaultThinkingLevel":"medium"}\n')
    await mkdir(agentDir, { recursive: true })
    await writeFile(join(agentDir, 'settings.json'), userSettings)

    ensureBuiltinPiConfig({ agentDir, defaultsPath })

    assert.equal(
      await readFile(join(agentDir, 'settings.json'), 'utf8'),
      userSettings,
    )
  })
})
