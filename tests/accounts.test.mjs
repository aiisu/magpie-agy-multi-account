import { test, expect, beforeEach, afterEach } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AccountManager } from '../multi-account/manager.mjs'
import { PREFIX, accountRef, accountDirectory, createAccount, accountEnvironment, registeredAccounts } from '../multi-account/account-store.mjs'

let root, authFile, manager, first, second

async function seed(email) {
  const id = await createAccount(root)
  const directory = path.join(accountDirectory(root, id), 'home/.gemini/antigravity-cli')
  await fs.mkdir(directory, { mode: 0o700 })
  await fs.writeFile(path.join(directory, 'antigravity-oauth-token'), JSON.stringify({
    id_token_email: email, token: { refresh_token: 'synthetic-test-value' },
  }), { mode: 0o600 })
  return id
}

async function save(ids) {
  await fs.writeFile(authFile, JSON.stringify(Object.fromEntries(ids.map((id, index) => [
    index ? `agy-cli#${index}` : 'agy-cli', { type: 'api', key: PREFIX + id },
  ]))))
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-accounts-test-'))
  authFile = path.join(root, 'auth.json')
  first = await seed('first@example.invalid')
  second = await seed('second@example.invalid')
  await save([first, second])
  manager = new AccountManager({ root, authFile, realAgy: '/unused',
    workerFile: fileURLToPath(new URL('./fixtures/worker.mjs', import.meta.url)) })
})

afterEach(async () => {
  await manager.close()
  await fs.rm(root, { recursive: true, force: true })
})

test('rejects traversal, legacy credentials and other providers', async () => {
  expect(() => accountRef({ type: 'api', key: 'agy' })).toThrow()
  expect(() => accountDirectory(root, '../../etc')).toThrow()
  expect(() => accountRef({ type: 'oauth', refresh: PREFIX + first })).toThrow()
  await fs.writeFile(authFile, JSON.stringify({ unrelated: { type: 'api', key: PREFIX + first } }))
  expect((await registeredAccounts(authFile)).size).toBe(0)
  await expect(manager.rpc(first, 'models')).rejects.toMatchObject({ status: 401 })
})

test('separates environments, identities, model and usage responses concurrently', async () => {
  const results = await Promise.all([first, second].map(id => manager.rpc(id, 'environment')))
  expect(results[0].home).not.toBe(results[1].home)
  expect(results[0].state).not.toBe(results[1].state)
  const models = await Promise.all([first, second].map(id => manager.rpc(id, 'models')))
  expect(Object.keys(models[0])).toEqual(['first@example.invalid'])
  expect(Object.keys(models[1])).toEqual(['second@example.invalid'])
  expect((await manager.rpc(second, 'usage')).user).toBe('second@example.invalid')
  const env = accountEnvironment({ GEMINI_API_KEY: 'wrong', GOOGLE_API_KEY: 'wrong' }, root, 'control', '/cli', '/launcher', '/slots')
  expect(env.GEMINI_API_KEY).toBeUndefined()
  expect(env.GOOGLE_API_KEY).toBeUndefined()
  expect(env.AGY_BRIDGE_MAX_PROCS).toBe('1')
  expect((await fs.stat(accountDirectory(root, first))).mode & 0o777).toBe(0o700)
})

test('preserves Request bodies and token-count paths', async () => {
  const response = await manager.request(first, new Request('http://example.invalid/v1/messages/count_tokens', {
    method: 'POST', body: '{"messages":[]}',
  }))
  expect(await response.json()).toEqual({ identity: 'first@example.invalid', path: '/v1/messages/count_tokens', body: '{"messages":[]}' })
  expect(manager.workers.get(first).active).toBe(0)
})

test('releases a cancelled stream without touching the other account', async () => {
  const response = await manager.request(first, 'http://example.invalid/stream', { body: '{}' })
  const reader = response.body.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('first@example.invalid')
  expect(manager.workers.get(first).active).toBe(1)
  await reader.cancel()
  expect(manager.workers.get(first).active).toBe(0)
  expect((await manager.rpc(second, 'usage')).user).toBe('second@example.invalid')
})

test('removes signed-out credentials and processes, preserving unrelated accounts', async () => {
  await manager.rpc(first, 'models')
  const child = manager.workers.get(first).child
  await save([second])
  await manager.sweep()
  expect(manager.workers.has(first)).toBe(false)
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  expect(await fs.stat(accountDirectory(root, first)).catch(() => null)).toBeNull()
  expect((await manager.rpc(second, 'usage')).user).toBe('second@example.invalid')
})

test('does not delete credentials when the auth store is unreadable', async () => {
  await manager.rpc(first, 'models')
  await fs.writeFile(authFile, '{broken')
  await expect(manager.sweep()).rejects.toThrow()
  expect(await fs.stat(accountDirectory(root, first))).toBeTruthy()
})

test('evicts idle workers and preserves their persistent profiles', async () => {
  await manager.rpc(first, 'models')
  await manager.rpc(second, 'models')
  const third = await seed('third@example.invalid')
  await save([first, second, third])
  expect((await manager.rpc(third, 'usage')).user).toBe('third@example.invalid')
  expect(manager.workers.size).toBe(2)
  expect(await fs.stat(accountDirectory(root, first))).toBeTruthy()
})

test('busy capacity and a crashed worker do not corrupt another account', async () => {
  const streams = await Promise.all([first, second].map(id => manager.request(id, 'http://example.invalid/stream', { body: '{}' })))
  const third = await seed('third@example.invalid')
  await save([first, second, third])
  await expect(manager.rpc(third, 'models')).rejects.toMatchObject({ status: 503 })
  await Promise.all(streams.map(response => response.body.cancel()))
  const child = manager.workers.get(first).child
  const exited = new Promise(resolve => child.once('exit', resolve))
  child.kill('SIGKILL')
  await exited
  expect((await manager.rpc(first, 'usage')).user).toBe('first@example.invalid')
  expect((await manager.rpc(second, 'usage')).user).toBe('second@example.invalid')
})

test('pending sign-ins have separate bounded capacity from serving accounts', async () => {
  const pendingFirst = await seed('pending-first@example.invalid')
  const pendingSecond = await seed('pending-second@example.invalid')
  await manager.rpc(pendingFirst, 'environment', {}, undefined, true)
  await manager.rpc(pendingSecond, 'environment', {}, undefined, true)
  const pendingThird = await seed('pending-third@example.invalid')
  await expect(manager.rpc(pendingThird, 'environment', {}, undefined, true)).rejects.toMatchObject({ status: 503 })
  expect((await manager.rpc(first, 'usage')).user).toBe('first@example.invalid')
  expect((await manager.rpc(second, 'usage')).user).toBe('second@example.invalid')
  expect(manager.workers.size).toBe(4)
})
