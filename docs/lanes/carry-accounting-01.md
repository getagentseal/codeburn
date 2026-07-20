# carry-accounting-01

## Touched files

| file | added | deleted |
|---|---:|---:|
| `src/daily-cache.ts` | 91 | 5 |
| `src/day-aggregator.ts` | 23 | 11 |
| `tests/daily-cache-carry-forward.test.ts` | 239 | 1 |
| `tests/day-aggregator.test.ts` | 78 | 3 |
| `docs/lanes/carry-accounting-01.md` | 288 | 0 |

## New tests

| file | test |
|---|---|
| `tests/daily-cache-carry-forward.test.ts` | `partial carry with new-format slice counts does not inflate day turn totals` |
| `tests/daily-cache-carry-forward.test.ts` | `coverage keeps a sessions-only placeholder inside the fresh provider window` |
| `tests/daily-cache-carry-forward.test.ts` | `savings-hash re-derive uses the plain provider floor` |
| `tests/daily-cache-carry-forward.test.ts` | `timezone change drops the adjacent old day when a turn migrates across midnight` |
| `tests/daily-cache-carry-forward.test.ts` | `timezone change preserves genuine carry before widened fresh coverage` |
| `tests/daily-cache-carry-forward.test.ts` | `loads legacy duplicated slice turn counts without repairing them` |
| `tests/day-aggregator.test.ts` | `attributes a multi-provider turn to the majority provider exactly once` |
| `tests/day-aggregator.test.ts` | `breaks a provider call-count tie with the turn's first call` |

## Existing tests modified

| file | test | old expectation | new expectation | reason |
|---|---|---|---|---|
| `tests/day-aggregator.test.ts` | `aggregates per-model and per-provider totals inside each day` | `codex.categories.coding` matches `{ turns: 1, cost: 3 }`; comment says every slice owns the turn | `codex.categories.coding` matches `{ turns: 0, cost: 3 }`; comment says the tied first-call provider owns the turn | primary-provider turn attribution; per-provider cost unchanged |

## Command results

| command | cwd | environment | timeout seconds | exit code |
|---|---|---|---:|---:|
| `npx vitest run tests/day-aggregator.test.ts tests/daily-cache-carry-forward.test.ts` | `/Volumes/T8/Claude Projects/codeburn` | default | 180 | 0 |
| `npx tsc --noEmit` | `/Volumes/T8/Claude Projects/codeburn` | default | 180 | 0 |
| `npx vitest run` | `/Volumes/T8/Claude Projects/codeburn` | `VITEST_MAX_THREADS=2 VITEST_MIN_THREADS=2` | 300 | 1 |
| `npx vitest run tests/spend-flow.test.ts` | `/Volumes/T8/Claude Projects/codeburn` | default | 180 | 0 |
| `npx vitest run tests --testTimeout 15000 --reporter=dot` | `/private/tmp/codeburn-carry-gate.6o9Z58` | clean `HEAD` + 4 lane files; `VITEST_MAX_THREADS=2 VITEST_MIN_THREADS=2` | 300 | 0 |
| `npx vitest run` | `/private/tmp/codeburn-carry-gate.6o9Z58` | clean `HEAD` + 4 lane files; locked `app` dependencies; `VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1` | 300 | 1 |

## `npx vitest run tests/day-aggregator.test.ts tests/daily-cache-carry-forward.test.ts`

```text
 RUN  v3.2.6 /Volumes/T8/Claude Projects/codeburn

 ✓ tests/day-aggregator.test.ts (12 tests) 14ms
 ✓ tests/daily-cache-carry-forward.test.ts (45 tests) 325ms

 Test Files  2 passed (2)
      Tests  57 passed (57)
   Start at  15:55:16
   Duration  692ms (transform 96ms, setup 37ms, collect 118ms, tests 339ms, environment 0ms, prepare 150ms)
```

## `npx vitest run`

Exit code: `1`

Verbatim terminal tail:

```text
 FAIL  tests/cli-json-daily.test.ts > codeburn report --format json daily[] one-shot fields (issue #279) > includes older sessions under --period lifetime but not under --period all
Error: Test timed out in 5000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ tests/cli-json-daily.test.ts:238:3
    236|   })
    237|
    238|   it('includes older sessions under --period lifetime but not under --…
       |   ^
    239|     const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-json-lifet…
    240|

 FAIL  tests/cli-status-menubar.test.ts > codeburn status --format menubar-json > filters the whole menubar payload to a selected Claude config source
Error: Test timed out in 5000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ tests/cli-status-menubar.test.ts:186:3

 Test Files  50 failed | 173 passed | 2 skipped (225)
      Tests  2 failed | 2285 passed | 5 skipped (2292)
   Start at  15:59:25
   Duration  52.51s (transform 4.50s, setup 3.84s, collect 19.24s, tests 270.79s, environment 16.15s, prepare 14.26s)
```

## Full-gate discovery blockers

```text
tests/._daily-cache-carry-forward.test.ts:1:0: ERROR: Unexpected "\x00"
```

```text
Error: Failed to resolve import "@testing-library/react" from "app/renderer/components/StackedBars.test.tsx". Does the file exist?
```

```text
ABSENT app/node_modules/@testing-library/react
```

## Clean root-test diagnostic

```text
 Test Files  162 passed | 2 skipped (164)
      Tests  2060 passed | 5 skipped (2065)
   Start at  16:04:48
   Duration  37.42s (transform 3.25s, setup 2.42s, collect 16.08s, tests 204.69s, environment 30ms, prepare 10.14s)
```

## `npx tsc --noEmit`

Exit code: `0`

```text
```

## `grep -rn "editTurns\|oneShotTurns" src/ dash/src/`

Exit code: `0`

```text
src/act/model-defaults.ts:33:  return s.editTurns > 0 ? s.oneShotTurns / s.editTurns : 0
src/act/model-defaults.ts:37:  return s.editTurns > 0 ? s.editCost / s.editTurns : Number.POSITIVE_INFINITY
src/act/model-defaults.ts:68:      totalEditTurns += breakdown.editTurns
src/act/model-defaults.ts:70:    debuggingEditTurns += session.categoryBreakdown.debugging?.editTurns ?? 0
src/act/model-defaults.ts:78:    .filter(s => s.model !== '<synthetic>' && s.editTurns >= MIN_EDIT_TURNS)
src/act/model-defaults.ts:79:    .sort((a, b) => b.editTurns - a.editTurns || b.editCost - a.editCost)
src/act/model-defaults.ts:121:    currentEditTurns: current.editTurns,
src/act/model-defaults.ts:122:    candidateEditTurns: best.candidate.editTurns,
src/act/report.ts:334:  if (!stats || stats.editTurns < 20) {
src/act/report.ts:338:  const postApplyRate = stats.oneShotTurns / stats.editTurns
src/daily-cache.ts:79:export type CategoryDayStats = { turns: number; cost: number; savingsUSD: number; editTurns: number; oneShotTurns: number }
src/daily-cache.ts:99:  editTurns?: number
src/daily-cache.ts:100:  oneShotTurns?: number
src/daily-cache.ts:116:  editTurns: number
src/daily-cache.ts:117:  oneShotTurns: number
src/daily-cache.ts:221:      editTurns: num(c.editTurns),
src/daily-cache.ts:222:      oneShotTurns: num(c.oneShotTurns),
src/daily-cache.ts:228:const OPTIONAL_SLICE_NUMERICS = ['sessions', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'editTurns', 'oneShotTurns'] as const
src/daily-cache.ts:287:      editTurns: num(d.editTurns),
src/daily-cache.ts:288:      oneShotTurns: num(d.oneShotTurns),
src/daily-cache.ts:497:    editTurns: 0,
src/daily-cache.ts:498:    oneShotTurns: 0,
src/daily-cache.ts:534:  day.editTurns += slice.editTurns ?? 0
src/daily-cache.ts:535:  day.oneShotTurns += slice.oneShotTurns ?? 0
src/daily-cache.ts:548:    const acc = Object.hasOwn(day.categories, cat) ? day.categories[cat]! : { turns: 0, cost: 0, savingsUSD: 0, editTurns: 0, oneShotTurns: 0 }
src/daily-cache.ts:552:    acc.editTurns += c.editTurns
src/daily-cache.ts:553:    acc.oneShotTurns += c.oneShotTurns
src/day-aggregator.ts:16:    editTurns: 0,
src/day-aggregator.ts:17:    oneShotTurns: 0,
src/day-aggregator.ts:33:    editTurns: 0, oneShotTurns: 0, models: {}, categories: {},
src/day-aggregator.ts:89:        const editTurns = turn.hasEdits ? 1 : 0
src/day-aggregator.ts:90:        const oneShotTurns = turn.hasEdits && turn.retries === 0 ? 1 : 0
src/day-aggregator.ts:94:        turnDay.editTurns += editTurns
src/day-aggregator.ts:95:        turnDay.oneShotTurns += oneShotTurns
src/day-aggregator.ts:97:        const cat = turnDay.categories[turn.category] ?? { turns: 0, cost: 0, savingsUSD: 0, editTurns: 0, oneShotTurns: 0 }
src/day-aggregator.ts:101:        cat.editTurns += editTurns
src/day-aggregator.ts:102:        cat.oneShotTurns += oneShotTurns
src/day-aggregator.ts:130:          turnSlice.editTurns! += ownsTurn ? editTurns : 0
src/day-aggregator.ts:131:          turnSlice.oneShotTurns! += ownsTurn ? oneShotTurns : 0
src/day-aggregator.ts:132:          const sliceCat = turnSlice.categories![turn.category] ?? { turns: 0, cost: 0, savingsUSD: 0, editTurns: 0, oneShotTurns: 0 }
src/day-aggregator.ts:136:          sliceCat.editTurns += ownsTurn ? editTurns : 0
src/day-aggregator.ts:137:          sliceCat.oneShotTurns += ownsTurn ? oneShotTurns : 0
src/day-aggregator.ts:209:  const catTotals: Record<string, { turns: number; cost: number; savingsUSD: number; editTurns: number; oneShotTurns: number }> = {}
src/day-aggregator.ts:230:      const acc = catTotals[cat] ?? { turns: 0, cost: 0, savingsUSD: 0, editTurns: 0, oneShotTurns: 0 }
src/day-aggregator.ts:234:      acc.editTurns += c.editTurns
src/day-aggregator.ts:235:      acc.oneShotTurns += c.oneShotTurns
src/dashboard.tsx:434:        const oneShotLabel = efficiency && efficiency.editTurns >= MIN_EDIT_TURNS_FOR_RATE && efficiency.oneShotRate !== null
src/dashboard.tsx:463:  const categoryTotals: Record<string, { turns: number; costUSD: number; editTurns: number; oneShotTurns: number }> = {}
src/dashboard.tsx:464:  const skillTotals: Record<string, { turns: number; costUSD: number; editTurns: number; oneShotTurns: number }> = {}
src/dashboard.tsx:468:        if (!categoryTotals[cat]) categoryTotals[cat] = { turns: 0, costUSD: 0, editTurns: 0, oneShotTurns: 0 }
src/dashboard.tsx:471:        categoryTotals[cat].editTurns += data.editTurns
src/dashboard.tsx:472:        categoryTotals[cat].oneShotTurns += data.oneShotTurns
src/dashboard.tsx:475:        if (!skillTotals[skill]) skillTotals[skill] = { turns: 0, costUSD: 0, editTurns: 0, oneShotTurns: 0 }
src/dashboard.tsx:478:        skillTotals[skill].editTurns += data.editTurns
src/dashboard.tsx:479:        skillTotals[skill].oneShotTurns += data.oneShotTurns
src/dashboard.tsx:490:        const oneShotPct = data.editTurns > 0 ? Math.round((data.oneShotTurns / data.editTurns) * 100) + '%' : '-'
src/dashboard.tsx:497:            <Text color={data.editTurns === 0 ? DIM : oneShotPct === '100%' ? '#5BF58C' : ORANGE}>{String(oneShotPct).padStart(7)}</Text>
src/dashboard.tsx:502:            const subPct = sd.editTurns > 0 ? Math.round((sd.oneShotTurns / sd.editTurns) * 100) + '%' : '-'
src/usage-aggregator.ts:18:  const catTotals: Record<string, { turns: number; cost: number; savingsUSD: number; editTurns: number; oneShotTurns: number }> = {}
src/usage-aggregator.ts:28:      if (!catTotals[cat]) catTotals[cat] = { turns: 0, cost: 0, savingsUSD: 0, editTurns: 0, oneShotTurns: 0 }
src/usage-aggregator.ts:32:      catTotals[cat].editTurns += d.editTurns
src/usage-aggregator.ts:33:      catTotals[cat].oneShotTurns += d.oneShotTurns
src/usage-aggregator.ts:512:    .filter(m => m.retries > 0 && m.editTurns > 0)
src/usage-aggregator.ts:515:      taxUSD: m.retries * (m.editCostUSD / m.editTurns),
src/usage-aggregator.ts:523:    editTurns: [...effMap.values()].filter(m => m.retries > 0).reduce((s, m) => s + m.editTurns, 0),
src/usage-aggregator.ts:540:    .filter(m => m.oneShotRate !== null && m.oneShotRate >= 90 && m.editTurns >= 5
src/usage-aggregator.ts:546:        .filter(m => m.model !== baseline.model && m.editTurns > 0 && (m.costPerEditUSD ?? 0) > (baseline.costPerEditUSD ?? 0))
src/usage-aggregator.ts:548:          const counterfactual = m.editTurns * (baseline.costPerEditUSD ?? 0)
src/usage-aggregator.ts:552:            editTurns: m.editTurns,
src/compare-stats.ts:17:  editTurns: number
src/compare-stats.ts:18:  oneShotTurns: number
src/compare-stats.ts:32:      s = { model, calls: 0, cost: 0, outputTokens: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTurns: 0, editTurns: 0, oneShotTurns: 0, retries: 0, selfCorrections: 0, editCost: 0, firstSeen: '', lastSeen: '' }
src/compare-stats.ts:48:          ms.editTurns++
src/compare-stats.ts:49:          if (turn.retries === 0) ms.oneShotTurns++
src/compare-stats.ts:88:  editTurnsA: number
src/compare-stats.ts:91:  editTurnsB: number
src/compare-stats.ts:129:    compute: s => s.editTurns > 0 ? (s.oneShotTurns / s.editTurns) * 100 : null,
src/compare-stats.ts:136:    compute: s => s.editTurns > 0 ? s.retries / s.editTurns : null,
src/compare-stats.ts:157:    compute: s => s.editTurns > 0 ? s.editCost / s.editTurns : null,
src/compare-stats.ts:203:  type Accum = { turns: number; editTurns: number; oneShotTurns: number }
src/compare-stats.ts:209:    if (!a) { a = { turns: 0, editTurns: 0, oneShotTurns: 0 }; map.set(cat, a) }
src/compare-stats.ts:223:          acc.editTurns++
src/compare-stats.ts:224:          if (turn.retries === 0) acc.oneShotTurns++
src/compare-stats.ts:236:    if ((!a || a.editTurns === 0) && (!b || b.editTurns === 0)) continue
src/compare-stats.ts:238:    const rateA = a && a.editTurns > 0 ? (a.oneShotTurns / a.editTurns) * 100 : null
src/compare-stats.ts:239:    const rateB = b && b.editTurns > 0 ? (b.oneShotTurns / b.editTurns) * 100 : null
src/compare-stats.ts:244:      editTurnsA: a?.editTurns ?? 0,
src/compare-stats.ts:247:      editTurnsB: b?.editTurns ?? 0,
src/compare.tsx:249:    { label: 'Edit turns', valueA: modelA.editTurns.toLocaleString(), valueB: modelB.editTurns.toLocaleString() },
src/compare.tsx:290:            const turnsA = cat.editTurnsA > 0 ? `(${cat.editTurnsA})` : ''
src/compare.tsx:291:            const turnsB = cat.editTurnsB > 0 ? `(${cat.editTurnsB})` : ''
src/main.ts:473:  // consumer summing daily[].editTurns over a period gets the same total as
src/main.ts:474:  // sum(activities[].editTurns) for that period: every turn counts once for
src/main.ts:475:  // `turns`, edit turns count for `editTurns`, edit turns with zero retries
src/main.ts:476:  // count for `oneShotTurns`. Issue #279 — daily-resolution efficiency
src/main.ts:478:  const dailyMap: Record<string, { cost: number; savings: number; calls: number; turns: number; editTurns: number; oneShotTurns: number }> = {}
src/main.ts:485:      // sum(daily[].editTurns) === sum(activities[].editTurns) invariant.
src/main.ts:489:      if (!dailyMap[day]) { dailyMap[day] = { cost: 0, savings: 0, calls: 0, turns: 0, editTurns: 0, oneShotTurns: 0 } }
src/main.ts:492:        dailyMap[day].editTurns += 1
src/main.ts:493:        if (turn.retries === 0) dailyMap[day].oneShotTurns += 1
src/main.ts:508:    editTurns: d.editTurns,
src/main.ts:509:    oneShotTurns: d.oneShotTurns,
src/main.ts:513:    oneShotRate: d.editTurns > 0
src/main.ts:514:      ? Math.round((d.oneShotTurns / d.editTurns) * 1000) / 10
src/main.ts:577:        editTurns: efficiency?.editTurns ?? 0,
src/main.ts:578:        oneShotTurns: efficiency?.oneShotTurns ?? 0,
src/main.ts:587:  const catMap: Record<string, { turns: number; cost: number; savings: number; editTurns: number; oneShotTurns: number }> = {}
src/main.ts:590:      if (!catMap[cat]) { catMap[cat] = { turns: 0, cost: 0, savings: 0, editTurns: 0, oneShotTurns: 0 } }
src/main.ts:594:      catMap[cat].editTurns += d.editTurns
src/main.ts:595:      catMap[cat].oneShotTurns += d.oneShotTurns
src/main.ts:605:      editTurns: d.editTurns,
src/main.ts:606:      oneShotTurns: d.oneShotTurns,
src/main.ts:607:      oneShotRate: d.editTurns > 0 ? Math.round((d.oneShotTurns / d.editTurns) * 1000) / 10 : null,
src/parser.ts:1442:      categoryBreakdown[turn.category] = { turns: 0, costUSD: 0, savingsUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 }
src/parser.ts:1448:      categoryBreakdown[turn.category].editTurns++
src/parser.ts:1450:      if (turn.retries === 0) categoryBreakdown[turn.category].oneShotTurns++
src/parser.ts:1456:        skillBreakdown[skillKey] = { turns: 0, costUSD: 0, savingsUSD: 0, editTurns: 0, oneShotTurns: 0 }
src/parser.ts:1462:        skillBreakdown[skillKey].editTurns++
src/parser.ts:1463:        if (turn.retries === 0) skillBreakdown[skillKey].oneShotTurns++
src/export.ts:170:        'Edit Turns': efficiency?.editTurns ?? 0,
src/menubar-json.ts:26:  categories: Array<{ name: string; cost: number; savingsUSD: number; turns: number; editTurns: number; oneShotTurns: number }>
src/menubar-json.ts:221:      editTurns: number
src/menubar-json.ts:236:        editTurns: number
src/menubar-json.ts:270:function oneShotRateFor(editTurns: number, oneShotTurns: number): number | null {
src/menubar-json.ts:271:  if (editTurns === 0) return null
src/menubar-json.ts:272:  return oneShotTurns / editTurns
src/menubar-json.ts:279:    edits += cat.editTurns
src/menubar-json.ts:280:    oneShots += cat.oneShotTurns
src/menubar-json.ts:298:    oneShotRate: oneShotRateFor(cat.editTurns, cat.oneShotTurns),
src/menubar-json.ts:435:      retryTax: retryTax ?? { totalUSD: 0, retries: 0, editTurns: 0, byModel: [] },
src/model-efficiency.ts:6:  editTurns: number
src/model-efficiency.ts:7:  oneShotTurns: number
src/model-efficiency.ts:32:      stats = { model, editTurns: 0, oneShotTurns: 0, retries: 0, editCostUSD: 0 }
src/model-efficiency.ts:48:        stats.editTurns++
src/model-efficiency.ts:49:        if (turn.retries === 0) stats.oneShotTurns++
src/model-efficiency.ts:60:    oneShotRate: rate(stats.oneShotTurns, stats.editTurns),
src/model-efficiency.ts:61:    retriesPerEdit: stats.editTurns > 0 ? Math.round((stats.retries / stats.editTurns) * 10) / 10 : null,
src/model-efficiency.ts:62:    costPerEditUSD: stats.editTurns > 0 ? stats.editCostUSD / stats.editTurns : null,
src/optimize.ts:1342:  editTurns: number
src/optimize.ts:1344:  oneShotTurns: number
src/optimize.ts:1354:  editTurns: number
src/optimize.ts:1356:  oneShotTurns: number
src/optimize.ts:1427:      editTurns: 0,
src/optimize.ts:1429:      oneShotTurns: 0,
src/optimize.ts:1460:          acc.editTurns++
src/optimize.ts:1468:            acc.oneShotTurns++
src/optimize.ts:1477:    if (acc.editTurns < CAPABILITY_RELIABILITY_MIN_EDIT_TURNS) continue
src/optimize.ts:1479:    const retryRate = acc.retryTurns / acc.editTurns
src/optimize.ts:1485:      editTurns: acc.editTurns,
src/optimize.ts:1487:      oneShotTurns: acc.oneShotTurns,
src/optimize.ts:1535:    return `${formatCapabilityKind(c.kind)} ${c.name}: ${c.retryTurns}/${c.editTurns} edit turns retried (${percent}%), ${c.retries} retries${projects}`
src/optimize.ts:2503:    || category.editTurns > 0
src/optimize.ts:2504:    || category.oneShotTurns > 0
src/optimize.ts:2510:    return Object.values(session.categoryBreakdown).reduce((sum, c) => sum + c.editTurns, 0)
src/optimize.ts:2517:    return Object.values(session.categoryBreakdown).reduce((sum, c) => sum + c.oneShotTurns, 0)
src/optimize.ts:2547:  editTurns: number,
src/optimize.ts:2551:  if (editTurns === 0) return Math.round(tokens * WORTH_IT_NO_EDIT_RECOVERY_FRACTION)
src/optimize.ts:2581:      const editTurns = sessionEditTurns(session)
src/optimize.ts:2582:      const oneShotTurns = sessionOneShotTurns(session)
src/optimize.ts:2586:      if (editTurns === 0 && session.totalCostUSD >= WORTH_IT_NO_EDIT_MIN_COST_USD) {
src/optimize.ts:2593:        editTurns > 0
src/optimize.ts:2594:        && oneShotTurns === 0
src/optimize.ts:2607:        tokens: estimateLowWorthRecoverableTokens(session, editTurns, retries),
src/types.ts:189:  categoryBreakdown: Record<TaskCategory, { turns: number; costUSD: number; savingsUSD: number; retries: number; editTurns: number; oneShotTurns: number }>
src/types.ts:190:  skillBreakdown: Record<string, { turns: number; costUSD: number; savingsUSD: number; editTurns: number; oneShotTurns: number }>
```

STATUS: BLOCKED (`npx vitest run` exits 1: 48 pre-existing discovery/import suite failures plus unrelated 5-second CLI timeouts; tried isolated timeout reproduction, a clean HEAD-plus-lane snapshot with locked app dependencies and one worker, and all clean root tests with a 15-second diagnostic timeout)
