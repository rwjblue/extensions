// Copyright ©️ 2026 Robert Jackson (N1RWJ)
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HookContext, JSONValue } from '@ham2k/extension-sdk'
import { resolveCwtExchange } from '../history/index.ts'
import { contact, createHistoryAdapter } from './history.ts'

type Qson = Record<string, JSONValue>
const operation = { uuid: 'op', refs: [{ type: 'cwt', ref: '2026-09-23-1300' }] }
const candidate = { their: { call: 'K1ABC' } }
const empty = { currentOperation: [], olderHistory: [] }

function qso(uuid: string, number = '1234'): Qson {
  return {
    uuid,
    their: { call: 'K1ABC' },
    refs: [{ type: 'cwt', name: 'AL', number }],
    startAtMillis: 1000,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

for (const call of ['K1ABC', 'K1ABC/P']) {
  test(`finds older CWT history behind five unrelated contacts for ${call}`, async () => {
    const older = qso('older', '2345')
    const rows: Qson[] = [
      ...Array.from({ length: 5 }, (_, i) => ({
        ...qso(`other-${i}`),
        refs: [{ type: 'sst', name: 'OTHER', location: 'CT' }],
      })),
      older,
    ]
    const calls: unknown[] = []
    let reads = 0
    const ctx: HookContext = {
      online: false,
      getQsos: async () => {
        reads++
        throw new Error('Must not read the full log')
      },
      getHistoryForCall: async (key, options) => {
        calls.push([key, options])
        return rows
          .filter(
            (row) =>
              (row.their as Qson).call === key &&
              (!options?.refType ||
                (row.refs as Qson[]).some((ref) => ref.type === options.refType)),
          )
          .slice(0, 5)
      },
    }
    const history = createHistoryAdapter()
    history.update({ operation, qsos: [] })
    assert.deepEqual(await history.find(operation, { their: { call } }, ctx), {
      currentOperation: [],
      olderHistory: [contact(older)],
    })
    assert.deepEqual(
      calls,
      (call === 'K1ABC' ? [call] : [call, 'K1ABC']).map((key) => [key, { refType: 'cwt' }]),
    )
    assert.equal(reads, 0, 'scoring already supplied membership')
  })
}

test('still rejects unrelated history when an older host ignores the filter', async () => {
  const older = qso('older')
  const unrelated = { ...qso('other'), refs: [{ type: 'sst', name: 'OTHER', location: 'CT' }] }
  assert.deepEqual(
    await createHistoryAdapter().find(operation, candidate, {
      online: false,
      getHistoryForCall: async () => [unrelated, older],
    }),
    { currentOperation: [], olderHistory: [contact(older)] },
  )
})

test('UUID-less requests require a unique scoring identity; an explicit UUID takes priority', async () => {
  const history = createHistoryAdapter()
  const native = { stationCall: 'N1RWJ/TEST', createdAtMillis: 1000, refs: operation.refs }
  const current = qso('current')
  history.update({ operation: { ...native, uuid: 'first' }, qsos: [current] })
  let reads = 0
  const ctx = {
    online: false,
    getQsos: async () => {
      reads++
      return []
    },
    getHistoryForCall: async () => [current],
  }
  assert.deepEqual(await history.find(native, candidate, ctx), {
    currentOperation: [contact(current)],
    olderHistory: [],
  })
  for (const mismatch of [{ createdAtMillis: 2000 }, { stationCall: 'W1XYZ' }]) {
    assert.deepEqual(
      (await history.find({ ...native, ...mismatch }, candidate, ctx)).currentOperation,
      [],
    )
  }
  history.update({ operation: { ...native, uuid: 'second' }, qsos: [qso('other')] })
  assert.deepEqual((await history.find(native, candidate, ctx)).currentOperation, [])
  assert.deepEqual(
    (await history.find({ ...native, uuid: 'first' }, candidate, ctx)).currentOperation,
    [contact(current)],
  )
  assert.equal(reads, 0, 'scoring already supplied membership')
})

test('fresh targeted exchanges keep current and older history separate, excluding edits and deletions', async () => {
  const history = createHistoryAdapter()
  history.update({ operation, qsos: [qso('current', '1111')] })
  const current = qso('current', '2222')
  const older = qso('older', '2345')
  let targeted = [older, current]
  const ctx = { online: false, getHistoryForCall: async () => targeted }
  assert.deepEqual(await history.find(operation, candidate, ctx), {
    currentOperation: [contact(current)],
    olderHistory: [contact(older)],
  })
  assert.deepEqual(await history.find(operation, current, ctx), {
    currentOperation: [],
    olderHistory: [contact(older)],
  })
  targeted = []
  assert.deepEqual(await history.find(operation, candidate, ctx), empty)
})

test('a named checkpoint append reloads membership once and preserves current-operation precedence', async () => {
  const history = createHistoryAdapter()
  const current = qso('current', '5555')
  const appended = { ...qso('appended'), their: { call: 'K2XYZ' } }
  history.update({ operation, qsos: [current] })
  history.update({ operation, qsos: [appended], resumeKey: 'checkpoint' })
  let reads = 0
  const ctx = {
    online: false,
    getQsos: async () => {
      reads++
      return [current, appended]
    },
    getHistoryForCall: async () => [current],
  }
  const results = await Promise.all([
    history.find(operation, candidate, ctx),
    history.find(operation, candidate, ctx),
  ])
  for (const result of results) {
    const resolved = resolveCwtExchange({
      call: 'K1ABC',
      ...result,
      selectedFile: { K1ABC: { call: 'K1ABC', number: '1234', membership: 'member' } },
    })
    assert.equal(resolved.number?.value, '5555')
    assert.equal(resolved.number?.source, 'current-operation')
  }
  await history.find(operation, candidate, ctx)
  assert.equal(reads, 1)
})

test('older hosts without targeted history use local rows while filtering deleted and unrelated contacts', async () => {
  const member = qso('member')
  const rows = [
    member,
    { ...qso('deleted'), deleted: true },
    { ...qso('event'), band: 'event' },
    { ...qso('other'), refs: [{ type: 'naqp', name: 'AL', number: 'CT' }] },
  ]
  assert.deepEqual(
    await createHistoryAdapter().find(operation, candidate, {
      online: false,
      getQsos: async () => rows,
    }),
    { currentOperation: [contact(member)], olderHistory: [] },
  )
})

test('missing or rejected optional history methods degrade without repeated full reads', async () => {
  assert.deepEqual(
    await createHistoryAdapter().find(operation, candidate, { online: false }),
    empty,
  )
  let reads = 0
  const history = createHistoryAdapter()
  const ctx = {
    online: false,
    getQsos: async () => {
      reads++
      throw new Error('unavailable')
    },
    getHistoryForCall: async () => {
      throw new Error('unavailable')
    },
  }
  assert.deepEqual(await history.find(operation, candidate, ctx), empty)
  await history.find(operation, candidate, ctx)
  assert.equal(reads, 1)
})

for (const resumed of [false, true]) {
  test(`${resumed ? 'resumed' : 'full'} scoring supersedes a pending initial read without losing current precedence`, async () => {
    const initialRead = deferred<Qson[]>()
    const refreshedRead = deferred<Qson[]>()
    const refreshStarted = deferred<void>()
    const current = qso('new', '5555')
    const earlier = qso('earlier', '')
    const rows = [earlier, current]
    const history = createHistoryAdapter()
    let reads = 0
    let targetedReads = 0
    const ctx: HookContext = {
      online: false,
      getQsos: (uuid) => {
        assert.equal(uuid, 'op')
        reads++
        if (reads === 1) return initialRead.promise
        refreshStarted.resolve()
        return refreshedRead.promise
      },
      getHistoryForCall: async () => {
        targetedReads++
        return rows
      },
    }
    const first = history.find(operation, candidate, ctx)
    const second = history.find(operation, candidate, ctx)
    history.update({
      operation,
      qsos: resumed ? [current] : rows,
      resumeFrom: resumed ? {} : undefined,
    })
    initialRead.resolve([])
    if (resumed) {
      await refreshStarted.promise
      assert.equal(targetedReads, 0)
      refreshedRead.resolve(rows)
    }
    const results = await Promise.all([first, second])
    for (const result of results) {
      assert.deepEqual(result, { currentOperation: rows.map(contact), olderHistory: [] })
      const resolved = resolveCwtExchange({
        call: 'K1ABC',
        ...result,
        selectedFile: { K1ABC: { call: 'K1ABC', number: '1234', membership: 'member' } },
      })
      assert.equal(resolved.number?.value, '5555')
      assert.equal(resolved.number?.source, 'current-operation')
    }
    await history.find(operation, candidate, ctx)
    assert.equal(reads, resumed ? 2 : 1)
  })
}

test('portable lookups query exact and base calls but never trust generic exchange strings', async () => {
  const calls: string[] = []
  assert.deepEqual(
    await createHistoryAdapter().find(
      operation,
      { their: { call: 'K1ABC/P' } },
      {
        online: false,
        getHistoryForCall: async (call) => {
          calls.push(call)
          return [{ uuid: 'generic', their: { call: 'K1ABC', exchange: 'AL 1234' } }]
        },
      },
    ),
    empty,
  )
  assert.deepEqual(calls, ['K1ABC/P', 'K1ABC'])
})

test('non-CWT operations and incomplete calls do not read history', async () => {
  let reads = 0
  const unexpectedRead = async () => {
    reads++
    return []
  }
  const ctx = {
    online: false,
    getQsos: unexpectedRead,
    getHistoryForCall: unexpectedRead,
  }
  const history = createHistoryAdapter()
  assert.deepEqual(await history.find({ uuid: 'op' }, candidate, ctx), empty)
  assert.deepEqual(await history.find(operation, { their: { call: 'K' } }, ctx), empty)
  assert.equal(reads, 0)
})

test('a current field omitted by capped targeted history is revalidated once per signature and scoring generation', async () => {
  let rows = [
    qso('sixth', '5555'),
    ...Array.from({ length: 5 }, (_, index) => qso(`recent-${index}`, '')),
  ]
  let targeted = rows.slice(1)
  let reads = 0
  const ctx = {
    online: false,
    getQsos: async () => {
      reads++
      return rows
    },
    getHistoryForCall: async () => targeted,
  }
  const history = createHistoryAdapter()
  history.update({ operation, qsos: rows })
  const resolved = resolveCwtExchange({
    call: 'K1ABC',
    ...(await history.find(operation, candidate, ctx)),
    selectedFile: { K1ABC: { call: 'K1ABC', number: '9999', membership: 'member' } },
  })
  assert.equal(resolved.number?.value, '5555')
  assert.equal(resolved.number?.source, 'current-operation')
  await Promise.all(Array.from({ length: 5 }, () => history.find(operation, candidate, ctx)))
  assert.equal(reads, 1)
  history.update({ operation, qsos: rows })
  await history.find(operation, candidate, ctx)
  assert.equal(reads, 2)

  // A changed signature revalidates deletions. Previously current rows must
  // not fall into older history if the full read finds they were removed.
  rows = []
  targeted = targeted.slice(0, 1)
  assert.deepEqual(await history.find(operation, candidate, ctx), empty)
  await history.find(operation, candidate, ctx)
  assert.equal(reads, 3)
})

test('failed validation retains fresh targeted rows without retrying the whole log per call', async () => {
  const history = createHistoryAdapter()
  history.update({ operation, qsos: [qso('current'), qso('omitted')] })
  let reads = 0
  const ctx = {
    online: false,
    getQsos: async () => {
      reads++
      throw new Error('unavailable')
    },
    getHistoryForCall: async () => [qso('current', '2345')],
  }
  assert.deepEqual((await history.find(operation, candidate, ctx)).currentOperation, [
    contact(qso('current', '2345')),
  ])
  await history.find(operation, candidate, ctx)
  assert.equal(reads, 1)
})

test('concurrent validations share a read and discard it after a newer scoring pass', async () => {
  const history = createHistoryAdapter()
  history.update({ operation, qsos: [qso('stale')] })
  const started = deferred<void>()
  const pendingRead = deferred<Qson[]>()
  let reads = 0
  const ctx = {
    online: false,
    getQsos: () => {
      reads++
      started.resolve()
      return pendingRead.promise
    },
    getHistoryForCall: async () => [],
  }
  const first = history.find(operation, candidate, ctx)
  const second = history.find(operation, candidate, ctx)
  await started.promise
  history.update({ operation, qsos: [] })
  pendingRead.resolve([qso('stale')])
  assert.deepEqual(await first, empty)
  assert.deepEqual(await second, empty)
  assert.equal(reads, 1)
})
