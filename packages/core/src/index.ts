export * from './schema.js'
export * from './observations.js'
export * from './diagnostics.js'
export * from './fingerprint.js'
export * from './contracts.js'
// Detectors: re-export only the documented API — the detector functions, the
// stable `detectors` list, and their id/algorithm-version constants. The
// ./detectors subpath also re-exports ./shared.js, which drags internal
// helpers (AVG_TOKENS_PER_READ, JUNK_RESOURCE_CLASSES, READ/EDIT_TOOL_NAMES,
// clamp01, forEachCall) into any `export *` of it; those stay out of the root
// barrel so tuning a constant or renaming a helper is not a 1.0 break. They
// remain reachable via the './detectors' subpath.
export {
  detectors,
  junkReadsDetector,
  duplicateReadsDetector,
  contextBloatDetector,
  JUNK_READS_DETECTOR_ID,
  JUNK_READS_ALGORITHM_VERSION,
  DUPLICATE_READS_DETECTOR_ID,
  DUPLICATE_READS_ALGORITHM_VERSION,
  CONTEXT_BLOAT_DETECTOR_ID,
  CONTEXT_BLOAT_ALGORITHM_VERSION,
} from './detectors/index.js'
