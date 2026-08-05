// Resolves a concrete schema subpath through @codeburn/core's own exports map
// via Node's self-reference (the nearest package.json up from this file has
// "name" + "exports"), then loads it as a JSON module — exactly the resolution
// a consumer's `import '@codeburn/core/schemas/...'` performs. Exits non-zero
// if the subpath is not exported, the file is missing, or the JSON is invalid.
import { fileURLToPath } from 'node:url'

const subpath = process.argv[2]
if (!subpath) {
  console.error('schema-resolve: expected a package subpath argument')
  process.exit(2)
}

const mod = await import(subpath, { with: { type: 'json' } })
const schema = mod.default
const version = schema?.definitions?.ObservationEnvelope?.properties?.schemaVersion?.const
if (version == null) {
  console.error(`schema-resolve: ${subpath} loaded but is not the observation envelope schema`)
  process.exit(3)
}
console.log(`SCHEMA_EXPORT_OK ${version}`)
