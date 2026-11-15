import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { accountDirectory, prepareAccount, accountEnvironment, registeredAccounts, identity } from './account-store.mjs'

export class AccountManager {
  constructor({ root, authFile, realAgy, env = process.env, workerFile = fileURLToPath(new URL('./account-worker.mjs', import.meta.url)) }) {
    this.root = root
    this.authFile = authFile
    this.realAgy = realAgy
    this.env = env
    this.workerFile = workerFile
    this.workers = new Map()
    this.queue = Promise.resolve()
    this.sweeping = false
    this.registered = new Set()
    this.timer = setInterval(() => this.sweep().catch(() => {}), 5000)
    this.timer.unref()
    this.exit = () => {
      for (const worker of this.workers.values()) {
        try { process.kill(-worker.child.pid, 'SIGKILL') } catch {}
      }
    }
    process.once('exit', this.exit)
  }

  async serialized(action) {
    const result = this.queue.then(action)
    this.queue = result.catch(() => {})
    return result
  }

  async get(id, provisional = false) {
    return this.serialized(async () => {
      if (!provisional) {
        const registered = await registeredAccounts(this.authFile)
        if (!registered.has(id)) throw Object.assign(new Error('CLI account was removed; sign in again.'), { status: 401 })
        this.registered.add(id)
        await identity(this.root, id).catch(() => {
          throw Object.assign(new Error('CLI account credential is missing; sign in again.'), { status: 401 })
        })
      }
      let worker = this.workers.get(id)
      if (worker) {
        worker.lastUsed = Date.now()
        worker.active++
        return worker
      }
      if (this.workers.size >= 2) {
        for (const candidate of [...this.workers.values()].sort((first, second) => first.lastUsed - second.lastUsed)) {
          if (candidate.active || candidate.provisional) continue
          const status = await this.control(candidate, 'status').catch(() => ({ busy: true }))
          if (status.busy || status.requests || status.login) continue
          await this.stop(candidate)
          break
        }
      }
      if (this.workers.size >= 2) throw Object.assign(new Error('CLI account capacity is busy; retry after an active turn finishes.'), { status: 503 })
      const directory = await prepareAccount(this.root, id)
      const slots = path.join(this.root, 'slots')
      await fs.mkdir(slots, { recursive: true, mode: 0o700 })
      const token = randomBytes(32).toString('hex')
      const environment = accountEnvironment(this.env, directory, token, this.realAgy,
        fileURLToPath(new URL('./cli-launcher.sh', import.meta.url)), slots)
      const child = spawn(process.execPath, [this.workerFile], {
        env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      worker = { id, child, token, active: 1, provisional, created: Date.now(), lastUsed: Date.now(), url: '' }
      this.workers.set(id, worker)
      child.stderr.resume()
      child.once('exit', () => {
        if (this.workers.get(id) === worker) this.workers.delete(id)
        try { process.kill(-child.pid, 'SIGKILL') } catch {}
      })
      try {
        worker.url = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('CLI account worker did not start.')), 10000)
          const lines = createInterface({ input: child.stdout })
          const finish = (error, port) => {
            clearTimeout(timer)
            lines.removeAllListeners('line')
            lines.close()
            child.stdout.resume()
            if (error) reject(error)
            else resolve('http://127.0.0.1:' + port)
          }
          lines.on('line', line => {
            try {
              const message = JSON.parse(line)
              if (Number.isInteger(message.port) && message.port > 0 && message.port < 65536) finish(null, message.port)
            } catch {}
          })
          child.once('error', () => finish(new Error('CLI account worker failed to start.')))
          child.once('exit', () => finish(new Error('CLI account worker exited.')))
        })
      } catch (error) {
        await this.stop(worker)
        throw error
      }
      return worker
    })
  }

  async control(worker, method, data = {}, signal) {
    const response = await fetch(worker.url + (method === 'status' ? '/status' : '/rpc'), {
      method: method === 'status' ? 'GET' : 'POST',
      headers: { authorization: 'Bearer ' + worker.token, 'content-type': 'application/json' },
      ...(method === 'status' ? {} : { body: JSON.stringify({ method, ...data }) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(65000)]) : AbortSignal.timeout(65000),
    })
    const result = await response.json()
    if (!response.ok) throw Object.assign(new Error(result.error || 'CLI account worker request failed.'), { status: response.status })
    return result
  }

  async rpc(id, method, data = {}, signal, provisional = false) {
    const worker = await this.get(id, provisional)
    try { return await this.control(worker, method, data, signal) }
    finally { worker.active--; worker.lastUsed = Date.now() }
  }

  async request(id, input, init = {}) {
    const worker = await this.get(id)
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      worker.active--
      worker.lastUsed = Date.now()
    }
    try {
      const original = input instanceof Request ? input : null
      const headers = new Headers(init.headers || original?.headers)
      headers.set('authorization', 'Bearer ' + worker.token)
      const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url
      headers.set('x-agy-request-path', new URL(url).pathname)
      const response = await fetch(worker.url + '/fetch', { ...init, method: 'POST', headers,
        body: init.body ?? (original ? await original.text() : undefined),
        signal: init.signal || original?.signal })
      if (!response.body) { finish(); return response }
      const reader = response.body.getReader()
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const chunk = await reader.read()
            if (chunk.done) { finish(); controller.close() }
            else controller.enqueue(chunk.value)
          } catch (error) { finish(); controller.error(error) }
        },
        async cancel(reason) { try { await reader.cancel(reason) } finally { finish() } },
      })
      return new Response(stream, { status: response.status, headers: response.headers })
    } catch (error) { finish(); throw error }
  }

  async stop(worker) {
    if (this.workers.get(worker.id) !== worker) return
    this.workers.delete(worker.id)
    try { worker.child.kill('SIGTERM') } catch {}
    await Promise.race([
      new Promise(resolve => worker.child.exitCode !== null ? resolve() : worker.child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 1000)),
    ])
    try { process.kill(-worker.child.pid, 'SIGKILL') } catch {}
  }

  async discard(id) {
    return this.serialized(() => this.remove(id))
  }

  async remove(id) {
    const worker = this.workers.get(id)
    if (worker) await this.stop(worker)
    await fs.rm(accountDirectory(this.root, id), { recursive: true, force: true })
  }

  async sweep() {
    if (this.sweeping) return
    this.sweeping = true
    try {
      await this.serialized(async () => {
        const registered = await registeredAccounts(this.authFile)
        for (const id of this.registered) {
          if (!registered.has(id)) await this.remove(id)
        }
        this.registered = registered
        const entries = await fs.readdir(this.root, { withFileTypes: true }).catch(() => [])
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          let directory
          try { directory = accountDirectory(this.root, entry.name) } catch { continue }
          const worker = this.workers.get(entry.name)
          const created = worker?.created ?? (await fs.stat(directory)).mtimeMs
          if (!registered.has(entry.name) && Date.now() - created > 16 * 60000) {
            await this.remove(entry.name)
            continue
          }
          if (!worker || worker.provisional || worker.active || Date.now() - worker.lastUsed < 120000) continue
          const status = await this.control(worker, 'status').catch(() => ({ busy: true }))
          if (!status.busy && !status.requests && !status.login) await this.stop(worker)
        }
      })
    } finally { this.sweeping = false }
  }

  async close() {
    clearInterval(this.timer)
    process.removeListener('exit', this.exit)
    await Promise.all([...this.workers.values()].map(worker => this.stop(worker)))
  }
}
