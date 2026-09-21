// Turns the CLI's truecolor ANSI output into the <span> soup that terminal.html embeds.
// Usage: node ansi2html.mjs < capture.ansi > body.html
import { readFileSync } from 'node:fs'
const text = readFileSync(0, 'utf-8')
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

let out = ''
for (const line of text.split('\n')) {
  let open = 0
  let i = 0
  const re = /\x1b\[([0-9;]*)m/g
  let m
  let last = 0
  let buf = ''
  while ((m = re.exec(line))) {
    buf += esc(line.slice(last, m.index))
    last = m.index + m[0].length
    const codes = m[1].split(';').map(Number)
    for (let k = 0; k < codes.length; k++) {
      const c = codes[k]
      if (c === 38 && codes[k + 1] === 2) {
        buf += `<span style="color:rgb(${codes[k + 2]},${codes[k + 3]},${codes[k + 4]})">`; open++; k += 4
      } else if (c === 1) { buf += '<span style="font-weight:700">'; open++ }
      else if (c === 2) { buf += '<span style="opacity:.62">'; open++ }
      else if (c === 39 || c === 22 || c === 0) { if (open) { buf += '</span>'; open-- } }
    }
  }
  buf += esc(line.slice(last))
  buf += '</span>'.repeat(open)
  out += buf + '\n'
}
process.stdout.write(out)
