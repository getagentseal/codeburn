import * as Module from 'node:module'

const discoveryFixtureUrl = `data:text/javascript,${encodeURIComponent(`
export async function browse() {
  return [{
    name: 'Fixture Mac',
    host: 'fixture.local',
    port: 7777,
    fingerprint: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  }]
}

export function advertise() {
  return { stop: async () => {} }
}
`)}`

function resolve(specifier, context, nextResolve) {
  if (specifier === './sharing/discovery.js' || specifier.endsWith('/sharing/discovery.js')) {
    return { url: discoveryFixtureUrl, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}

if (typeof Module.registerHooks === 'function') {
  Module.registerHooks({ resolve })
} else {
  Module.register(`data:text/javascript,${encodeURIComponent(`
const discoveryFixtureUrl = ${JSON.stringify(discoveryFixtureUrl)}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === './sharing/discovery.js' || specifier.endsWith('/sharing/discovery.js')) {
    return { url: discoveryFixtureUrl, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
`)}`)
}
