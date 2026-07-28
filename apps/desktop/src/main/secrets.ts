import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import { join } from 'node:path'
import type { AiProvider, SecretsStore } from '@marcat/core'

/** Encrypted-at-rest store for the AI preference, Claude token and connector API keys. */
export function createSecrets(): SecretsStore {
  const fileFor = (name: string) => join(app.getPath('userData'), `secret-${name}.bin`)
  const cache = new Map<string, string | undefined>()

  const read = (name: string): string | undefined => {
    if (cache.has(name)) return cache.get(name)
    let val: string | undefined
    try {
      const file = fileFor(name)
      if (fs.existsSync(file) && safeStorage.isEncryptionAvailable()) {
        val = safeStorage.decryptString(fs.readFileSync(file))
      }
    } catch {
      val = undefined
    }
    cache.set(name, val)
    return val
  }
  const write = (name: string, value: string | null) => {
    cache.set(name, value || undefined)
    try {
      const file = fileFor(name)
      if (!value) {
        if (fs.existsSync(file)) fs.unlinkSync(file)
      } else if (safeStorage.isEncryptionAvailable()) {
        fs.writeFileSync(file, safeStorage.encryptString(value))
      }
    } catch {
      /* best effort */
    }
  }

  return {
    getClaudeToken: () => read('claude') || process.env.CLAUDE_CODE_OAUTH_TOKEN || undefined,
    setClaudeToken: (token) => write('claude', token),
    getAiProvider: () => {
      const provider = read('ai-provider')
      return provider === 'claude' || provider === 'codex' ? (provider as AiProvider) : undefined
    },
    setAiProvider: (provider) => write('ai-provider', provider),
    getApiKey: (provider) => read(`api-${provider}`),
    setApiKey: (provider, key) => write(`api-${provider}`, key),
  }
}
