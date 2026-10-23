import { describe, expect, it } from 'vitest'
import { createCollection } from '../../src/collection/index.js'
import { BTreeIndex } from '../../src/index.js'
import { createLiveQueryCollection } from '../../src/query/live-query-collection.js'
import { Query } from '../../src/query/builder/index.js'
import {
  eq,
  inArray,
  isUndefined,
  not,
  or,
} from '../../src/query/builder/functions.js'
import { compileSingleRowExpression } from '../../src/query/compiler/evaluators.js'
import { getLoadSubsetDemandKey } from '../../src/query/ir-stable-identity.js'
import { PropRef, Value } from '../../src/query/ir.js'
import type { LoadSubsetOptions, LoadSubsetRelation } from '../../src/types.js'

type Seek = { id: number; updatedAt: number; runId: string }
type Run = { id: string; seekId: number; userId: string }

const seeks: Array<Seek> = Array.from({ length: 40 }, (_, id) => ({
  id,
  updatedAt: id,
  runId: `run-${id}`,
}))
const runs: Array<Run> = seeks.map(({ id }) => ({
  id: `run-${id}`,
  seekId: id,
  userId: id % 5 === 0 ? `user` : `admin`,
}))
const runsById = new Map(runs.map((run) => [run.id, run]))

const read = (row: object, path: Array<string>) =>
  path.reduce<unknown>(
    (value, key) => (value as Record<string, unknown> | undefined)?.[key],
    row,
  )

function passesRelation(seek: Seek, relation: LoadSubsetRelation): boolean {
  const key = read(seek, relation.on.parent)
  const related = runs.filter((run) => read(run, relation.on.child) === key)
  const where = relation.where
    ? compileSingleRowExpression(relation.where)
    : () => true
  const matches = related.some((run) => where(run) === true)
  return relation.quantifier === `some` ? matches : !matches
}

function setup(
  applyRelations: boolean,
  synchronous = false,
  joinedDelayMs = 0,
) {
  const seekLoads: Array<LoadSubsetOptions> = []
  const delivered = new Set<number>()
  const seekCollection = createCollection<Seek>({
    id: `relations-seeks-${Math.random()}`,
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
            seekLoads.push(options)
            const where = options.where
              ? compileSingleRowExpression(options.where)
              : undefined
            const from = options.cursor
              ? compileSingleRowExpression(options.cursor.whereFrom)
              : undefined
            let matching = seeks
              .filter((row) => (where ? where(row) === true : true))
              .filter((row) =>
                applyRelations
                  ? (options.relations ?? []).every((relation) =>
                      passesRelation(row, relation),
                    )
                  : true,
              )
              .sort((a, b) => b.updatedAt - a.updatedAt)
            if (from) matching = matching.filter((row) => from(row) === true)
            else matching = matching.slice(options.offset ?? 0)
            const answer =
              options.limit === undefined
                ? matching
                : matching.slice(0, options.limit)
            begin()
            for (const row of answer) {
              if (delivered.has(row.id)) continue
              delivered.add(row.id)
              write({ type: `insert`, value: { ...row } })
            }
            const receipt = commit()
            if (synchronous) return receipt
            return receipt === true ? Promise.resolve() : receipt
          },
        }
      },
    },
  })
  const runCollection = createCollection<Run>({
    id: `relations-runs-${Math.random()}`,
    getKey: (row) => row.id,
    syncMode: `on-demand`,
    startSync: true,
    sync: {
      sync: ({ begin, write, commit, markReady }) => {
        markReady()
        return {
          loadSubset: (options: LoadSubsetOptions) => {
            const where = options.where
              ? compileSingleRowExpression(options.where)
              : undefined
            const answer = () => {
              begin()
              for (const run of runs) {
                if (where && where(run) !== true) continue
                write({ type: `insert`, value: { ...run } })
              }
              return commit()
            }
            if (joinedDelayMs > 0) {
              return new Promise<void>((resolve) =>
                setTimeout(() => {
                  const receipt = answer()
                  void (receipt === true ? resolve() : receipt.then(resolve))
                }, joinedDelayMs),
              )
            }
            const receipt = answer()
            if (synchronous) return receipt
            return receipt === true ? Promise.resolve() : receipt
          },
        }
      },
    },
  })
  return { seekLoads, delivered, seekCollection, runCollection }
}

const newestVisible = seeks
  .filter((seek) => runsById.get(seek.runId)!.userId !== `admin`)
  .sort((a, b) => b.updatedAt - a.updatedAt)
  .map(({ id }) => id)

describe(`relations hint on a joined-filter window`, () => {
  for (const [applyRelations, synchronous] of [
    [true, false],
    [false, false],
    [true, true],
    [false, true],
  ] as const) {
    it(`pages a to-one filter whose provider ${applyRelations ? `applies` : `ignores`} the hint${synchronous ? `, answering synchronously` : ``}`, async () => {
      const { seekLoads, delivered, seekCollection, runCollection } = setup(
        applyRelations,
        synchronous,
      )
      const live = createLiveQueryCollection({
        query: (q) =>
          q
            .from({ seek: seekCollection })
            .leftJoin({ run: runCollection }, ({ seek, run }) =>
              eq(seek.runId, run.id),
            )
            // Null-safe negation: a seek with no run is kept.
            .where(({ run }) =>
              or(isUndefined(run.userId), not(inArray(run.userId, [`admin`]))),
            )
            .orderBy(({ seek }) => seek.updatedAt, `desc`)
            .limit(3)
            .select(({ seek }) => ({ id: seek.id })),
      })
      await live.preload()
      await live.utils.setWindow({ offset: 3, limit: 3 })

      expect(Array.from(live.values(), ({ id }) => id)).toEqual(
        newestVisible.slice(3, 6),
      )
      expect(seekLoads.length).toBeGreaterThan(0)
      expect(seekLoads.every((load) => load.relations?.length === 1)).toBe(true)
      expect(seekLoads[0]!.relations![0]).toMatchObject({
        quantifier: `none`,
        collectionId: runCollection.id,
        on: { parent: [`runId`], child: [`id`] },
      })
      // Pages carry a limit; the only other loads are each boundary's ties.
      expect(
        seekLoads.every(
          (load) =>
            load.limit !== undefined ||
            (load.where?.type === `func` && load.where.name === `eq`),
        ),
      ).toBe(true)
      if (applyRelations) {
        // Only rows the relation keeps, plus at most a page of look-ahead.
        expect(delivered.size).toBeLessThanOrEqual(9)
        for (const id of delivered) {
          expect(runsById.get(seeks[id]!.runId)!.userId).toBe(`user`)
        }
      }
      await live.cleanup()
      await seekCollection.cleanup()
      await runCollection.cleanup()
    })
  }

  for (const subquery of [false, true])
    it(`waits for a slower joined side when the root answers synchronously${subquery ? ` (filter subquery)` : ``}`, async () => {
      const { seekCollection, runCollection } = setup(true, true, 5)
      const visibleRuns = new Query()
        .from({ run: runCollection })
        .where(({ run }) => not(eq(run.userId, `admin`)))
        .select(({ run }) => ({ k: run.seekId }))
        .distinct()
      const live = createLiveQueryCollection({
        query: (q) =>
          subquery
            ? q
                .from({ seek: seekCollection })
                .leftJoin({ visible: visibleRuns }, ({ seek, visible }) =>
                  eq(seek.id, visible.k),
                )
                .where(({ visible }) => not(isUndefined(visible.k)))
                .orderBy(({ seek }) => seek.updatedAt, `desc`)
                .limit(3)
                .select(({ seek }) => ({ id: seek.id }))
            : q
                .from({ seek: seekCollection })
                .leftJoin({ run: runCollection }, ({ seek, run }) =>
                  eq(seek.runId, run.id),
                )
                .where(({ run }) =>
                  or(
                    isUndefined(run.userId),
                    not(inArray(run.userId, [`admin`])),
                  ),
                )
                .orderBy(({ seek }) => seek.updatedAt, `desc`)
                .limit(3)
                .select(({ seek }) => ({ id: seek.id })),
      })
      await live.preload()
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(Array.from(live.values(), ({ id }) => id)).toEqual(
        newestVisible.slice(0, 3),
      )
      await live.cleanup()
      await seekCollection.cleanup()
      await runCollection.cleanup()
    })

  it(`sends an existence check as a relation`, async () => {
    const { seekLoads, seekCollection, runCollection } = setup(true)
    const live = createLiveQueryCollection({
      query: (q) =>
        q
          .from({ seek: seekCollection })
          .leftJoin({ run: runCollection }, ({ seek, run }) =>
            eq(seek.runId, run.id),
          )
          .where(({ run }) => not(isUndefined(run.id)))
          .orderBy(({ seek }) => seek.updatedAt, `desc`)
          .limit(2)
          .select(({ seek }) => ({ id: seek.id })),
    })
    await live.preload()
    expect(seekLoads[0]!.relations).toEqual([
      {
        quantifier: `some`,
        collectionId: runCollection.id,
        on: { parent: [`runId`], child: [`id`] },
      },
    ])
    await live.cleanup()
    await seekCollection.cleanup()
    await runCollection.cleanup()
  })

  for (const synchronous of [false, true])
  it(`pages an existence check over a filter subquery${synchronous ? `, answering synchronously` : ``}`, async () => {
    const { seekLoads, delivered, seekCollection, runCollection } = setup(
      true,
      synchronous,
    )
    const visibleRuns = new Query()
      .from({ run: runCollection })
      .where(({ run }) => not(eq(run.userId, `admin`)))
      .select(({ run }) => ({ k: run.seekId }))
      .distinct()
    const live = createLiveQueryCollection({
      query: (q) =>
        q
          .from({ seek: seekCollection })
          .leftJoin({ visible: visibleRuns }, ({ seek, visible }) =>
            eq(seek.id, visible.k),
          )
          .where(({ visible }) => not(isUndefined(visible.k)))
          .orderBy(({ seek }) => seek.updatedAt, `desc`)
          .limit(3)
          .select(({ seek }) => ({ id: seek.id })),
    })
    await live.preload()

    expect(Array.from(live.values(), ({ id }) => id)).toEqual(
      newestVisible.slice(0, 3),
    )
    expect(seekLoads[0]?.limit).toBeDefined()
    expect(seekLoads[0]!.relations).toEqual([
      {
        quantifier: `some`,
        collectionId: runCollection.id,
        on: { parent: [`id`], child: [`seekId`] },
        where: expect.objectContaining({ name: `not` }),
      },
    ])
    expect(delivered.size).toBeLessThanOrEqual(6)
    await live.cleanup()
    await seekCollection.cleanup()
    await runCollection.cleanup()
  })

  it(`keys a relation-filtered demand apart from the same demand without it`, () => {
    const where = eq(new PropRef([`updatedAt`]), new Value(1))
    const relation: LoadSubsetRelation = {
      quantifier: `some`,
      collectionId: `runs`,
      on: { parent: [`runId`], child: [`id`] },
    }
    expect(getLoadSubsetDemandKey({ where, limit: 3 })).not.toBe(
      getLoadSubsetDemandKey({ where, limit: 3, relations: [relation] }),
    )
    expect(getLoadSubsetDemandKey({ relations: [relation] })).toBeDefined()
  })
})
