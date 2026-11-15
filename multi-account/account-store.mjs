import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const PREFIX = 'agy-account:'
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function accountRef(auth) {
  const key = auth?.type === 'api' ? auth.key : ''
  const id = typeof key === 'string' && key.startsWith(PREFIX) ? key.slice(PREFIX.length) : ''
  if (!ACCOUNT_ID.test(id)) throw Object.assign(new Error('Sign in to this CLI account again in Magpie.'), { status: 401 })
  return id
}

export function accountDirectory(root, id) {
  if (!ACCOUNT_ID.test(id)) throw new Error('Invalid CLI account reference')
  return path.join(root, id)
}

export async function createAccount(root) {
  const id = randomUUID()
  await prepareAccount(root, id)
  return id
}

export async function prepareAccount(root, id) {
  const directory = accountDirectory(root, id)
  for (const suffix of ['', 'home', 'home/.gemini', 'state', 'cache', 'data', 'config', 'tmp']) {
    await fs.mkdir(path.join(directory, suffix), { recursive: true, mode: 0o700 })
    await fs.chmod(path.join(directory, suffix), 0o700)
  }
  return directory
}

export async function identity(root, id) {
  const file = path.join(accountDirectory(root, id), 'home/.gemini/antigravity-cli/antigravity-oauth-token')
  const stored = JSON.parse(await fs.readFile(file, 'utf8'))
  const email = stored.id_token_email
  if (typeof email !== 'string' || !email.includes('@') || !stored.token?.refresh_token) {
    throw new Error('CLI sign-in did not store a renewable Google account identity.')
  }
  return email
}

export function accountEnvironment(parent, directory, token, realAgy, launcher, slots) {
  const env = { ...parent }
  for (const name of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AGY_ADC_AUTH', 'GOOGLE_GENAI_USE_VERTEXAI',
    'GOOGLE_APPLICATION_CREDENTIALS', 'DBUS_SESSION_BUS_ADDRESS', 'GNOME_KEYRING_CONTROL']) delete env[name]
  return { ...env, HOME: path.join(directory, 'home'),
    XDG_CONFIG_HOME: path.join(directory, 'config'), XDG_STATE_HOME: path.join(directory, 'state'),
    XDG_CACHE_HOME: path.join(directory, 'cache'), XDG_DATA_HOME: path.join(directory, 'data'),
    TMPDIR: path.join(directory, 'tmp'), AGY_BRIDGE_GEMINI_DIR: 'default',
    AGY_BRIDGE_STATE_FILE: path.join(directory, 'state/sessions.json'),
    AGY_BRIDGE_MAX_PROCS: '1', AGY_BRIDGE_IDLE_MS: '60000', AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
    AGY_PATH: launcher, AGY_REAL_PATH: realAgy, AGY_ACCOUNT_SLOTS: slots,
    AGY_ACCOUNT_PARENT_PID: String(process.pid), AGY_ACCOUNT_CONTROL_TOKEN: token }
}

export async function registeredAccounts(file) {
  const stored = JSON.parse(await fs.readFile(file, 'utf8'))
  if (!stored || Array.isArray(stored) || typeof stored !== 'object') throw new Error('Invalid auth store')
  const refs = new Set()
  for (const [key, auth] of Object.entries(stored)) {
    if (key !== 'agy-cli' && !key.startsWith('agy-cli#')) continue
    try { refs.add(accountRef(auth)) } catch {}
  }
  return refs
}
