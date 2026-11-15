import { test, expect } from 'bun:test'
import { parseUsageReport } from '../usage.mjs'

const report = groups => ({ status: 'SUCCESS', command: { name: 'usage', data: { groups } } })
const bucket = (id, fraction, window = 'weekly') => ({ id, remaining_fraction: fraction, window,
  reset_time: '2030-01-01T00:00:00Z' })
const gemini = buckets => ({ name: 'Gemini Models',
  description: 'Models within this group: Gemini 4 Hydrogen, Gemini 3.8 Flash', buckets })
const thirdParty = buckets => ({ name: 'Claude and GPT models',
  description: 'Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B', buckets })
const argon = buckets => ({ name: 'Gemini 4 Argon', buckets })

test('binds measured shared windows to their models and effort variants', () => {
  const { windows } = parseUsageReport(report([
    gemini([bucket('gemini-weekly', 0.75), bucket('gemini-5h', 1, '5h')]),
    thirdParty([bucket('3p-weekly', 0.5), bucket('3p-5h', 0.8, '5h')]),
    argon([bucket('gemini-argon-wtu-weekly', 0.25)]),
  ]))
  expect(windows.map(window => window.used)).toEqual([25, 0, 50, 20, 75])
  expect(windows.map(window => window.span)).toEqual([604800, 18000, 604800, 18000, 604800])
  expect(windows.every(window => !window.aside && window.models.length &&
    window.resetsAt === '2030-01-01T00:00:00.000Z')).toBe(true)
  expect(windows[0].models).toEqual([
    'gemini-4-hydrogen', 'gemini-4-hydrogen-low', 'gemini-4-hydrogen-medium',
    'gemini-4-hydrogen-high', 'gemini-4-hydrogen-xhigh',
    'gemini-3.8-flash', 'gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high',
  ])
  expect(windows[1].models).toEqual(windows[0].models)
  expect(windows[2].pool).toBe('Claude & GPT (Opus / Sonnet, shared)')
  expect(windows[2].models).toContain('claude-opus-5-5')
  expect(windows[2].models).toContain('claude-sonnet-5-5-high')
  expect(windows[2].models).toContain('gpt-oss-120b-medium')
  expect(windows[3].models).toEqual(windows[2].models)
  expect(windows[4].models).toEqual([
    'gemini-4-argon', 'gemini-4-argon-low', 'gemini-4-argon-medium', 'gemini-4-argon-high',
  ])
  expect(windows.slice(0, 4).every(window => !window.models.includes('gemini-4-argon'))).toBe(true)
})

test('an exhausted pool does not mark other families or unverified aliases exhausted', () => {
  const { windows } = parseUsageReport(report([
    gemini([bucket('gemini-weekly', 0)]),
    thirdParty([bucket('3p-weekly', 1)]),
    argon([bucket('gemini-argon-wtu-weekly', 1)]),
  ]))
  const usedBy = model => windows.filter(window => !window.aside && window.models?.includes(model))
    .map(window => window.used)
  expect(usedBy('gemini-3.8-flash-high')).toEqual([100])
  expect(usedBy('gemini-4-argon-high')).toEqual([0])
  expect(usedBy('claude-opus-5-5')).toEqual([0])
  expect(usedBy('gemini-pro-orchestrator-g1-pro')).toEqual([])
  expect(usedBy('future-model')).toEqual([])
})

test('shared Argon quota requires explicit membership in that account report', () => {
  const { windows } = parseUsageReport(report([{
    ...gemini([bucket('gemini-weekly', 0.6)]),
    description: 'Models within this group: Gemini 4 Argon, Gemini 3.8 Flash',
  }]))
  expect(windows[0].models).toContain('gemini-4-argon')
  expect(windows[0].models).not.toContain('gemini-4-hydrogen')
})

test('missing membership, unfamiliar pools and invalid measurements stay informational', () => {
  const { windows } = parseUsageReport(report([
    { name: 'Gemini Models', buckets: [bucket('gemini-weekly', 0.5)] },
    { name: 'Future Pool', description: 'Models within this group: Future Model', buckets: [bucket('future', 1)] },
    argon([bucket('unknown-argon-bucket', 1)]),
    gemini([undefined, null, '1', -1, 2, NaN, Infinity].map(value => bucket('gemini-weekly', value))),
  ]))
  expect(windows.every(window => window.aside && !window.models)).toBe(true)
  expect(windows.slice(3).every(window => window.used === undefined && window.display === 'Limits not available')).toBe(true)
  expect(() => parseUsageReport(report([gemini([bucket('gemini-weekly', null)])]))).toThrow()
})

test('camel-case fields and disabled buckets preserve their existing semantics', () => {
  const { windows } = parseUsageReport(report([{
    ...thirdParty([]), buckets: [
      { bucketId: '3p-weekly', remainingFraction: 0.4, resetTime: '2030-01-01T00:00:00Z' },
      { ...bucket('3p-5h', 0, '5h'), disabled: true },
    ],
  }]))
  expect(windows).toHaveLength(1)
  expect(windows[0].used).toBe(60)
  expect(windows[0].models).toContain('gpt-oss-120b')
  expect(windows[0].resetsAt).toBe('2030-01-01T00:00:00.000Z')
})
