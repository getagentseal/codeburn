// @codeburn/core Cline CLI provider.
//
// Two layers:
//  - Rich pure decode (`decodeClineCli`): host-facing, NOT part of the stable
//    minimized surface. Pure over supplied records; carries content in-memory
//    but no pricing (cost leaves the decoder) and no bash base-name extraction
//    (that stays host-side with its `strip-ansi` dependency).
//  - Minimizing transform (`toObservations`): maps the rich decode into the
//    strict observation envelope; the content-smuggling guarantees bind here.

export {
  decodeClineCli,
  clineCliToolNameMap,
  PROVIDER_NAME,
  type ClineCliDecodeInput,
  type ClineCliDecodeResult,
} from './decode.js'

export {
  toObservations,
  type RichClineCliSessionDecode,
  type ClineCliToObservationsContext,
} from './observations.js'

export type {
  ClineCliDecodedCall,
  ClineCliMetrics,
  ClineCliSessionRecords,
  ClineCliToolCall,
} from './types.js'
