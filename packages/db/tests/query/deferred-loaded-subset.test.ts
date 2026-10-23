import { describe, expect, it } from 'vitest'
import { createCollection } from '../../src/collection/index.js'
import { BTreeIndex } from '../../src/index.js'
import { createLiveQueryCollection } from '../../src/query/live-query-collection.js'
import { eq } from '../../src/query/builder/functions.js'
import { compileSingleRowExpression } from '../../src/query/compiler/evaluators.js'
import { getLoadSubsetDemandKey } from '../../src/query/ir-stable-identity.js'
import type { LoadSubsetOptions } from '../../src/types.js'

type Row = { id: number; rank: number; group: string }

const rows: Array<Row> = Array.from({ length: 20 }, (_, id) => ({
  id,
  rank: 100 - id,
  group: id % 2 === 0 ? `even` : `odd`,
}))

function setup(withHook: boolean) {
  const loads: Array<LoadSubsetOptions> = []
  const loaded = new Set<string>()
  const keyOf = (options: LoadSubsetOptions) =>
    getLoadSubsetDemandKey(options) ?? `all`
  const source = createCollection<Row>({
    id: `deferred-loaded-${Math.random()}`,
    getKey: (row) => row.id,
    syncMode: `on-demand`,
    startSync: true,
    autoIndex: `eager`,
    defaultIndexType: BTreeIndex,
    gcTime: 0,
    sync: {
      sync: ({ begin, write, commit, markReady }) => {
        markReady()
        return {
          loadSubset: (options: LoadSubsetOptions) => {
            loads.push(options)
            const where = options.where
              ? compileSingleRowExpression(options.where)
              : undefined
            const answer = rows
              .filter((row) => (where ? where(row) === true : true))
              .sort((a, b) => b.rank - a.rank)
              .slice(0, options.limit)
            return new Promise<void>((resolve) =>
              setTimeout(() => {
                begin()
                for (const row of answer)
                  write({ type: `insert`, value: { ...row } })
                const receipt = commit()
                loaded.add(keyOf(options))
                void (receipt === true ? resolve() : receipt.then(resolve))
              }, 1),
            )
          },
          ...(withHook && {
            isSubsetLoaded: (options: LoadSubsetOptions) =>
              loaded.has(keyOf(options)),
          }),
        }
      },
    },
  })
  const query = () =>
    createLiveQueryCollection({
      startSync: true,
      query: (q) =>
        q
          .from({ row: source })
          .where(({ row }) => eq(row.group, `even`))
          .orderBy(({ row }) => row.rank, `desc`)
          .limit(3)
          .select(({ row }) => ({ id: row.id })),
    })
  return { loads, source, query }
}

describe(`a deferred live query over a subset the source already holds`, () => {
  it(`is ready with its rows before it subscribes, and still acquires after`, async () => {
    const { loads, source, query } = setup(true)
    const first = query()
    await first.preload()
    expect(Array.from(first.values(), ({ id }) => id)).toEqual([0, 2, 4])
    await first.cleanup()
    const before = loads.length

    const again = query()
    expect(again.status).toBe(`ready`)
    expect(Array.from(again.values(), ({ id }) => id)).toEqual([0, 2, 4])
    // no provider work until it has a subscriber
    expect(loads.length).toBe(before)

    const unsubscribe = again.subscribeChanges(() => {})
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(loads.length).toBeGreaterThan(before)
    expect(Array.from(again.values(), ({ id }) => id)).toEqual([0, 2, 4])
    unsubscribe.unsubscribe()
    await again.cleanup()
    await source.cleanup()
  })

  it(`stays loading before it subscribes when the source cannot tell`, async () => {
    const { source, query } = setup(false)
    const first = query()
    await first.preload()
    await first.cleanup()

    const again = query()
    expect(again.status).not.toBe(`ready`)
    expect(again.size).toBe(0)
    await again.cleanup()
    await source.cleanup()
  })

  it(`stays loading for a subset the source does not hold`, async () => {
    const { source, query } = setup(true)
    const again = query()
    expect(again.status).not.toBe(`ready`)
    expect(again.size).toBe(0)
    await again.cleanup()
    await source.cleanup()
  })
})
