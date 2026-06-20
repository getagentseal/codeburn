import { createInterface } from 'readline'

export function promptYesNo(question: string, timeoutMs?: number): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      rl.close()
      resolve(value)
    }
    if (timeoutMs) {
      const t = setTimeout(() => finish(false), timeoutMs)
      t.unref?.()
    }
    rl.question(`${question} [Y/n] `, (answer) => finish(!/^\s*n/i.test(answer)))
  })
}

export function promptChoice(question: string, max: number): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(`${question} `, (answer) => {
      rl.close()
      const n = Number.parseInt(answer.trim(), 10)
      resolve(Number.isInteger(n) && n >= 1 && n <= max ? n : -1)
    })
  })
}
