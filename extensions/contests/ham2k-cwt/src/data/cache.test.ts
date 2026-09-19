// Copyright © 2026 Robert Jackson, N1RWJ
// SPDX-License-Identifier: MIT

import type { JSONValue } from '@ham2k/extension-sdk'
import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import type { Snapshot, Storage } from './cache.ts'
import { checkedSnapshot, createFileCache } from './cache.ts'

const raw = '!!Order!!,Call,Name,Exch1\n# CWOPS\nK1ABC,Pat,123'

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    schema: 1,
    body: raw,
    url: 'https://n1mmwp.hamdocs.com/mmfile/get/file/CWOPS.txt',
    fetchedAt: '2026-09-19T12:00:00.000Z',
    ...overrides,
  }
}

function memoryStorage(initial: unknown = null) {
  let saved: unknown = initial
  const save = async (value: JSONValue) => { saved = value }
  const storage = {
    read: mock.fn<Storage['read']>(async () => saved),
    write: mock.fn<Storage['write']>(save),
  }
  return { storage, save, value: () => saved }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

// This tests injected storage, not native disk persistence. In the app, host KV
// is volatile; the native dataFile manager replays its last successful snapshot.
describe('last-good CWT file cache', () => {
  it('stores raw data and source freshness and restores them from backing storage', async () => {
    const { storage, value } = memoryStorage()
    const first = createFileCache(storage)
    await Promise.all([first.load(), first.load()])
    assert.equal(storage.read.mock.callCount(), 1)
    assert.equal(first.current(), undefined)
    assert.equal(first.error(), undefined)
    await first.replace(snapshot())
    assert.deepEqual(value(), snapshot())
    const restarted = createFileCache(storage)
    await restarted.load()
    assert.equal(restarted.current()?.snapshot.fetchedAt, '2026-09-19T12:00:00.000Z')
    assert.equal(restarted.current()?.parsed.records.K1ABC?.number, '123')
    assert.equal(restarted.error(), undefined)
  })

  const invalidSnapshots = [
    null,
    {},
    snapshot({ schema: 2 as 1 }),
    snapshot({ body: '<!DOCTYPE html><html>Access denied</html>' }),
    snapshot({ body: '# CWOPS' }),
    snapshot({ body: `<html>Access denied</html>\n${raw}` }),
    snapshot({ body: `${raw}\nK2XYZ,Jo,?` }),
    snapshot({ body: `${raw}\nTHIS IS CORRUPT` }),
    snapshot({ fetchedAt: 'not-a-date' }),
  ]
  for (const [index, candidate] of invalidSnapshots.entries()) {
    it(`rejects corrupt, incompatible, or invalid-version snapshot ${index + 1}`, () => {
      assert.throws(() => checkedSnapshot(candidate))
    })
  }

  it('rejects files beyond the size limit before parsing', () => {
    assert.throws(() => checkedSnapshot(snapshot({ body: 'x'.repeat(5_000_001) })), /5 MB/)
  })

  it('retains memory and stored copies when a corrupt refresh arrives', async () => {
    const { storage, value } = memoryStorage()
    const cache = createFileCache(storage)
    await cache.replace(snapshot())
    await assert.rejects(cache.replace(
      snapshot({ body: '<html>Access denied</html>', fetchedAt: '2026-09-20T00:00:00Z' }),
    ))
    assert.deepEqual(cache.current()?.snapshot, snapshot())
    assert.deepEqual(value(), snapshot())
    assert.equal(storage.write.mock.callCount(), 1)
    assert.match(cache.error() ?? '', /Invalid CWT file/)
  })

  it('reports unreadable or corrupt storage without rejecting host startup', async () => {
    const { storage } = memoryStorage({ body: 'bad' })
    const corrupt = createFileCache(storage)
    assert.equal(await corrupt.load(), undefined)
    assert.equal(corrupt.current(), undefined)
    assert.match(corrupt.error() ?? '', /Invalid CWT cache/)
    storage.read.mock.mockImplementationOnce(async () => { throw new Error('storage unavailable') })
    const unreadable = createFileCache(storage)
    assert.equal(await unreadable.load(), undefined)
    assert.match(unreadable.error() ?? '', /storage unavailable/)
  })

  it('retains the newest accepted host snapshot and ignores an older one', () => {
    const { storage } = memoryStorage()
    const cache = createFileCache(storage)
    const current = snapshot({ body: raw.replace('123', '456') })
    cache.accept(current)
    // 13:00 at +02:00 is older than 12:00 UTC despite its later clock hour.
    cache.accept(snapshot({ fetchedAt: '2026-09-19T13:00:00+02:00' }))
    assert.deepEqual(cache.current()?.snapshot, current)
    assert.equal(storage.write.mock.callCount(), 0)
    cache.accept({ schema: 1, body: 'bad' })
    assert.deepEqual(cache.current()?.snapshot, current)
  })

  it('a delayed startup read cannot overwrite a newer accepted host snapshot', async () => {
    const pending = deferred<unknown>()
    const { storage } = memoryStorage()
    storage.read.mock.mockImplementation(() => pending.promise)
    const cache = createFileCache(storage)
    const loading = cache.load()
    const fresh = snapshot({ body: raw.replace('123', '456') })
    cache.accept(fresh)
    pending.resolve(snapshot())
    await loading
    assert.deepEqual(cache.current()?.snapshot, fresh)
  })

  it('a delayed stale startup error cannot replace a successful refresh status', async () => {
    const pending = deferred<unknown>()
    const { storage } = memoryStorage()
    storage.read.mock.mockImplementation(() => pending.promise)
    const cache = createFileCache(storage)
    const loading = cache.load()
    await cache.replace(snapshot())
    pending.reject(new Error('stale startup failure'))
    await loading
    assert.equal(cache.error(), undefined)
    assert.deepEqual(cache.current()?.snapshot, snapshot())
  })

  it('removes the stored copy and prevents an old in-flight load from resurrecting it', async () => {
    const pending = deferred<unknown>()
    const { storage, value } = memoryStorage(snapshot())
    storage.read.mock.mockImplementation(() => pending.promise)
    const cache = createFileCache(storage)
    const loading = cache.load()
    await cache.remove()
    pending.resolve(snapshot())
    await loading
    assert.equal(value(), null)
    assert.equal(cache.current(), undefined)
    assert.equal(cache.error(), undefined)
  })

  it('serializes overlapping replacements so slower older writes cannot win', async () => {
    const firstWrite = deferred<void>()
    const firstStarted = deferred<void>()
    const { storage, value, save } = memoryStorage()
    storage.write.mock.mockImplementationOnce(async (candidate) => {
      firstStarted.resolve()
      await firstWrite.promise
      await save(candidate)
    })
    const cache = createFileCache(storage)
    const first = snapshot()
    const second = snapshot({ body: raw.replace('123', '456') })
    const replacingFirst = cache.replace(first)
    const replacingSecond = cache.replace(second)
    await firstStarted.promise
    assert.equal(storage.write.mock.callCount(), 1)
    assert.equal(cache.current(), undefined)
    firstWrite.resolve()
    await Promise.all([replacingFirst, replacingSecond])
    assert.equal(storage.write.mock.callCount(), 2)
    assert.deepEqual(value(), second)
    assert.deepEqual(cache.current()?.snapshot, second)
  })

  for (const lastAction of ['remove', 'replace']) {
    it(`orders an overlapping removal and replacement: ${lastAction} wins`, async () => {
      const write = deferred<void>()
      const started = deferred<void>()
      const { storage, value, save } = memoryStorage(snapshot())
      storage.write.mock.mockImplementationOnce(async (candidate) => {
        started.resolve()
        await write.promise
        await save(candidate)
      })
      const cache = createFileCache(storage)
      await cache.load()
      const next = snapshot({ body: raw.replace('123', '456') })
      const first = lastAction === 'remove' ? cache.replace(next) : cache.remove()
      const last = lastAction === 'remove' ? cache.remove() : cache.replace(next)
      await started.promise
      assert.equal(storage.write.mock.callCount(), 1)
      write.resolve()
      await Promise.all([first, last])
      assert.equal(storage.write.mock.callCount(), 2)
      assert.deepEqual(value(), lastAction === 'remove' ? null : next)
      assert.deepEqual(cache.current()?.snapshot, lastAction === 'remove' ? undefined : next)
    })
  }

  it('retains the last good file when a queued write fails and continues the next replacement', async () => {
    const nextWrite = deferred<void>()
    const nextStarted = deferred<void>()
    const { storage, value, save } = memoryStorage(snapshot())
    storage.write.mock.mockImplementationOnce(async () => {
      throw new Error('write failure')
    }, 0)
    storage.write.mock.mockImplementationOnce(async (candidate) => {
      nextStarted.resolve()
      await nextWrite.promise
      await save(candidate)
    }, 1)
    const cache = createFileCache(storage)
    await cache.load()
    const failing = cache.replace(snapshot({ body: raw.replace('123', '456') }))
    const failure = assert.rejects(failing, /write failure/)
    const newest = snapshot({ body: raw.replace('123', '789') })
    const succeeding = cache.replace(newest)
    await failure
    await nextStarted.promise
    assert.deepEqual(cache.current()?.snapshot, snapshot())
    assert.deepEqual(value(), snapshot())
    assert.match(cache.error() ?? '', /write failure/)
    nextWrite.resolve()
    await succeeding
    assert.deepEqual(cache.current()?.snapshot, newest)
    assert.deepEqual(value(), newest)
    assert.equal(cache.error(), undefined)
  })

  it('a failed removal retains the file and allows a subsequent replacement', async () => {
    const { storage } = memoryStorage(snapshot())
    const cache = createFileCache(storage)
    await cache.load()
    storage.write.mock.mockImplementationOnce(async () => { throw new Error('remove failed') })
    await assert.rejects(cache.remove(), /remove failed/)
    assert.deepEqual(cache.current()?.snapshot, snapshot())
    const next = snapshot({ body: raw.replace('123', '456') })
    await cache.replace(next)
    assert.deepEqual(cache.current()?.snapshot, next)
    assert.equal(cache.error(), undefined)
  })
})
