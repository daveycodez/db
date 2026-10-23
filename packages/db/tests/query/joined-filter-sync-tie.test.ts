import { expect, it } from 'vitest'
import { createCollection } from '../../src/collection/index.js'
import { BTreeIndex } from '../../src/index.js'
import { createLiveQueryCollection } from '../../src/query/live-query-collection.js'
import { eq } from '../../src/query/builder/functions.js'
import { compileSingleRowExpression } from '../../src/query/compiler/evaluators.js'
import type { LoadSubsetOptions } from '../../src/types.js'

type Item = { id: string; rank: number; ownerId: string }
type Owner = { id: string; active: boolean }

it(`settles a joined-filter window whose tie load answers synchronously`, async () => {
  const items: Array<Item> = Array.from({ length: 30 }, (_, n) => ({
    id: `i${String(n).padStart(2, `0`)}`,
    rank: 100 - n,
    ownerId: `o${n}`,
  }))
  const owners: Array<Owner> = items.map((item, n) => ({
    id: item.ownerId,
    active: n % 3 !== 0,
  }))
  const delivered = new Set<string>()
  const itemCollection = createCollection<Item>({
    id: `loop-items`,
    getKey: (row) => row.id,
    syncMode: `on-demand`,
    startSync: true,
    autoIndex: `eager`,
    defaultIndexType: BTreeIndex,
    sync: {
      sync: ({ begin, write, commit, markReady }) => {
        markReady()
        return {
          loadSubset: (options: LoadSubsetOptions) => {
            const where = options.where
              ? compileSingleRowExpression(options.where)
              : undefined
            const from = options.cursor
              ? compileSingleRowExpression(options.cursor.whereFrom)
              : undefined
            const offset = from ? 0 : (options.offset ?? 0)
            const rows = items
              .filter((row) => (where ? where(row) === true : true))
              .filter((row) => (from ? from(row) === true : true))
              .sort((a, b) => b.rank - a.rank)
              .slice(
                offset,
                options.limit === undefined
                  ? undefined
                  : offset + options.limit,
              )
            const answer = () => {
              begin()
              for (const row of rows) {
                if (delivered.has(row.id)) continue
                delivered.add(row.id)
                write({ type: `insert`, value: { ...row } })
              }
              return commit()
            }
            // A page goes over the wire; its boundary ties are rows it holds.
            if (options.limit === undefined) return answer()
            return new Promise<void>((resolve) =>
              setTimeout(() => {
                const receipt = answer()
                void (receipt === true ? resolve() : receipt.then(resolve))
              }, 1),
            )
          },
        }
      },
    },
  })
  const ownerCollection = createCollection<Owner>({
    id: `loop-owners`,
    getKey: (row) => row.id,
    syncMode: `on-demand`,
    startSync: true,
    autoIndex: `eager`,
    defaultIndexType: BTreeIndex,
    sync: {
      sync: ({ begin, write, commit, markReady }) => {
        markReady()
        return {
          loadSubset: (options: LoadSubsetOptions) =>
            new Promise<void>((resolve) =>
              setTimeout(() => {
                const where = options.where
                  ? compileSingleRowExpression(options.where)
                  : undefined
                begin()
                for (const row of owners)
                  if (!where || where(row) === true)
                    write({ type: `insert`, value: { ...row } })
                const receipt = commit()
                void (receipt === true ? resolve() : receipt.then(resolve))
              }, 1),
            ),
        }
      },
    },
  })
  const live = createLiveQueryCollection({
    query: (q) =>
      q
        .from({ item: itemCollection })
        .leftJoin({ owner: ownerCollection }, ({ item, owner }) =>
          eq(item.ownerId, owner.id),
        )
        .where(({ owner }) => eq(owner.active, true))
        .orderBy(({ item }) => item.rank, `desc`)
        .limit(5)
        .select(({ item }) => ({ id: item.id })),
  })
  await live.preload()
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(live.size).toBe(5)
  await live.cleanup()
})
