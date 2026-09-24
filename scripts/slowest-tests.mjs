// Prints the slowest cases from a vitest --reporter=json run, so drift toward a
// timeout is visible in CI before it starts failing there.
import { readFileSync } from 'node:fs'

const [file, top = '10'] = process.argv.slice(2)
let report
try {
  report = JSON.parse(readFileSync(file, 'utf-8'))
} catch (err) {
  console.log(`no test report at ${file}: ${err.message}`)
  process.exit(0)
}

const cases = (report.testResults ?? []).flatMap(suite =>
  (suite.assertionResults ?? []).map(test => ({
    ms: test.duration ?? 0,
    name: `${suite.name.split(/[\\/]/).pop()} > ${test.fullName ?? test.title}`,
  })),
)
cases.sort((a, b) => b.ms - a.ms)
for (const { ms, name } of cases.slice(0, Number(top))) {
  console.log(`${String(Math.round(ms)).padStart(7)}ms  ${name}`)
}
