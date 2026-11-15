import { test, expect } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { AccountManager } from '../multi-account/manager.mjs'
import { createAccount, identity, PREFIX } from '../multi-account/account-store.mjs'
import { parseUsageReport } from '../usage.mjs'

test('keeps shared quota pool labels and values', () => {
  const result = parseUsageReport({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [
    { displayName: 'Claude and GPT models', buckets: [{ bucketId: '5h', remainingFraction: 0.75 }] },
  ] } } })
  expect(result.windows[0]).toMatchObject({ name: '5 hours', pool: 'Claude & GPT (Opus / Sonnet, shared)', used: 25 })
})

test.skipIf(process.platform !== 'linux')('real workers maintain simultaneous logins, quota and restart isolation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-runtime-test-'))
  const authFile = path.join(root, 'auth.json')
  const realAgy = path.join(root, 'agy')
  const fixture = fileURLToPath(new URL('./fixtures/agy.mjs', import.meta.url))
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  await fs.writeFile(realAgy, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o700 })
  await fs.writeFile(authFile, '{}')
  const manager = new AccountManager({ root, authFile, realAgy })
  const holders = []
  try {
    const slots = path.join(root, 'slots')
    await fs.mkdir(slots, { mode: 0o700 })
    for (const slot of [0, 1]) {
      holders.push(spawn('/usr/bin/flock', [path.join(slots, `slot-${slot}.lock`), '/bin/sleep', '30'],
        { detached: true, stdio: 'ignore' }))
    }
    await Bun.sleep(100)
    const first = await createAccount(root)
    const second = await createAccount(root)
    const logins = await Promise.all([first, second].map(id => manager.rpc(id, 'authorize', {}, undefined, true)))
    expect(logins.every(login => login.method === 'code')).toBe(true)
    expect(logins[0].url).not.toBe(logins[1].url)
    const results = await Promise.all([first, second].map((id, index) => manager.rpc(id, 'finish', {
      code: index ? 'second@example.invalid' : 'first@example.invalid',
    }, undefined, true)))
    expect(results.map(result => result.type)).toEqual(['success', 'success'])
    expect(await identity(root, first)).toBe('first@example.invalid')
    expect(await identity(root, second)).toBe('second@example.invalid')
    for (const child of holders) {
      const stopped = new Promise(resolve => child.once('exit', resolve))
      process.kill(-child.pid, 'SIGKILL')
      await stopped
    }
    await fs.writeFile(authFile, JSON.stringify({ 'agy-cli': { type: 'api', key: PREFIX + first },
      'agy-cli#2': { type: 'api', key: PREFIX + second } }))
    const usages = await Promise.all([first, second].map(id => manager.rpc(id, 'usage')))
    expect(usages.map(result => result.windows[0].used)).toEqual([25, 50])
    const response = await manager.request(first, 'agy://local/v1/messages/count_tokens', {
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Count these tokens' }] }),
    })
    expect(response.status).toBe(200)
    expect((await response.json()).input_tokens).toBeGreaterThan(0)
    await manager.stop(manager.workers.get(first))
    expect((await manager.rpc(first, 'usage')).windows[0].used).toBe(25)
    expect(Object.keys(await manager.rpc(second, 'models'))).toContain('gemini-test-high')
  } finally {
    for (const child of holders) {
      try { process.kill(-child.pid, 'SIGKILL') } catch {}
    }
    await manager.close()
    await fs.rm(root, { recursive: true, force: true })
  }
}, 60000)

test.skipIf(process.platform !== 'linux')('global CLI slots remain locked until the CLI exits', async () => {
  const slots = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-slots-test-'))
  const launcher = fileURLToPath(new URL('../multi-account/cli-launcher.sh', import.meta.url))
  const children = []
  const start = seconds => {
    const child = spawn(launcher, [String(seconds)], { detached: true, stdio: 'ignore',
      env: { ...process.env, AGY_REAL_PATH: '/bin/sleep', AGY_ACCOUNT_SLOTS: slots } })
    children.push(child)
    return child
  }
  const exited = child => new Promise(resolve => child.once('exit', resolve))
  try {
    const first = start(30)
    start(30)
    await Bun.sleep(200)
    expect(await exited(start(0))).toBe(75)
    const stopped = exited(first)
    process.kill(-first.pid, 'SIGKILL')
    await stopped
    expect(await exited(start(0))).toBe(0)
  } finally {
    for (const child of children) {
      try { process.kill(-child.pid, 'SIGKILL') } catch {}
    }
    await fs.rm(slots, { recursive: true, force: true })
  }
}, 20000)
