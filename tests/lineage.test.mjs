import { test, expect } from 'bun:test'
import { lineageVerdict } from '../index.mjs'

const base = [{ role: 'user', content: 'Research a public question' }]
const call = id => ({ type: 'tool_use', id, name: 'research_async', input: {} })
const result = id => ({ type: 'tool_result', tool_use_id: id, content: 'Task accepted' })
const assistant = content => ({ role: 'assistant', content })
const user = content => ({ role: 'user', content })

function verdict(history, options = {}) {
  const turn = { calls: [{ id: 'pending' }], baseHistory: base, hasPendingMcp: () => true,
    ...options.turn }
  const proc = { expectedMessages: [...base, assistant([call('pending')])], ...options.proc }
  return lineageVerdict(proc, turn, { history, messages: [...history, user('Continue')],
    hasToolResults: false, ...options.request })
}

test('reclaims a detached tool turn completed in history by another provider', () => {
  const history = [...base, assistant([call('pending')]), user([result('pending')]),
    assistant('The other provider completed the task')]
  expect(verdict(history)).toBe('fork')
  expect(verdict(history, { turn: { baseHistory: [user('An older opening')] } })).toBe('fork')
})

test('requires every pending call to have an ordered matching result', () => {
  const calls = assistant([call('pending'), call('second')])
  const turn = { calls: [{ id: 'pending' }, { id: 'second' }] }
  expect(verdict([...base, calls, user([result('pending')]), assistant('Partial')], { turn })).toBe('conflict')
  expect(verdict([...base, calls, user([result('pending'), result('second')]), assistant('Done')], { turn })).toBe('fork')
  expect(verdict([...base, assistant([call('pending')]), user([result('unrelated')])])).toBe('conflict')
  expect(verdict([...base, user([result('pending')]), assistant([call('pending')])])).toBe('conflict')
  expect(verdict([...base, assistant([call('pending')]), assistant([result('pending')])])).toBe('conflict')
})

test('does not reclaim attached, cancelled, finalized or nonpending turns', () => {
  const history = [...base, assistant([call('pending')]), user([result('pending')]), assistant('Done')]
  for (const flag of ['attached', 'cancelRequested', 'steering', 'done', 'finalized']) {
    expect(verdict(history, { turn: { [flag]: true } })).toBeNull()
  }
  expect(verdict(history, { turn: { hasPendingMcp: () => false } })).toBeNull()
})

test('keeps unresolved calls conflicting and unrelated new branches recoverable', () => {
  expect(verdict([...base, assistant([call('pending')])])).toBe('conflict')
  expect(verdict([user('A new unrelated opening')])).toBe('fork')
})
