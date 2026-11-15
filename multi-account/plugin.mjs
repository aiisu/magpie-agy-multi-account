import path from 'node:path'
import os from 'node:os'
import { AccountManager } from './manager.mjs'
import { PREFIX, accountRef, createAccount, identity } from './account-store.mjs'

export async function MultiAccountPlugin() {
  if (process.platform !== 'linux') throw new Error('This multi-account CLI plugin currently requires Linux file-based sign-in.')
  const root = process.env.AGY_MULTI_ROOT || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'magpie-agy-accounts')
  const authFile = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'magpie/plugin-auth.json')
  const manager = new AccountManager({ root, authFile,
    realAgy: process.env.AGY_REAL_PATH || path.join(os.homedir(), '.local/bin/agy') })

  return {
    auth: {
      provider: 'agy-cli', single: false,
      methods: [{
        type: 'oauth', label: 'Sign in with Google · independent CLI account',
        async authorize(inputs, options = {}) {
          const id = await createAccount(root)
          const cancel = () => { manager.discard(id).catch(() => {}) }
          options.signal?.addEventListener('abort', cancel, { once: true })
          try {
            const login = await manager.rpc(id, 'authorize', {}, options.signal, true)
            if (login.type === 'failed') { await manager.discard(id); return login }
            return {
              url: login.url, method: login.method,
              instructions: 'Sign in to the Google account to add. This account has its own CLI login and sessions.',
              async callback(code, callbackOptions = {}) {
                try {
                  const result = await manager.rpc(id, 'finish', { code }, callbackOptions.signal, true)
                  if (result.type !== 'success') { await manager.discard(id); return result }
                  const email = await identity(root, id)
                  const worker = manager.workers.get(id)
                  if (worker) await manager.stop(worker)
                  options.signal?.removeEventListener('abort', cancel)
                  return { type: 'success', key: PREFIX + id, metadata: { email } }
                } catch (error) {
                  await manager.discard(id)
                  if (callbackOptions.signal?.aborted) throw error
                  return { type: 'failed', error: error.message }
                }
              },
            }
          } catch (error) {
            await manager.discard(id)
            if (options.signal?.aborted) throw error
            return { type: 'failed', error: error.message }
          }
        },
      }],
      async loader(getAuth) {
        return {
          baseURL: 'agy://local', apiKey: 'agy',
          async fetch(input, init) {
            try { return await manager.request(accountRef(await getAuth()), input, init) }
            catch (error) {
              return Response.json({ type: 'error', error: { type: 'api_error', message: error.message } }, {
                status: error.status || 502,
                headers: error.status === 401 ? { 'X-Magpie-Sign-In': 'expired' } : {},
              })
            }
          },
        }
      },
      async usage(getAuth, provider, options = {}) {
        try {
          const id = accountRef(await getAuth())
          const result = await manager.rpc(id, 'usage', {}, options.signal)
          return { ...result, user: await identity(root, id) }
        } catch (error) {
          return { windows: [], error: error.message, signIn: error.status === 401 ? 'expired' : 'kept' }
        }
      },
    },
    provider: {
      id: 'agy-cli', npm: '@ai-sdk/anthropic',
      async models(provider, { auth, signal } = {}) {
        if (!auth) return provider?.models || {}
        return manager.rpc(accountRef(auth), 'models', {}, signal)
      },
    },
  }
}

export default { id: 'agy-cli', server: MultiAccountPlugin }
