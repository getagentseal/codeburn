import antigravity from '../assets/providers/antigravity.png'
import claude from '../assets/providers/claude.svg'
import cline from '../assets/providers/cline.svg'
import codewhale from '../assets/providers/codewhale.svg'
import copilotDark from '../assets/providers/copilot-dark.svg'
import copilotLight from '../assets/providers/copilot-light.svg'
import crush from '../assets/providers/crush.png'
import cursorDark from '../assets/providers/cursor-dark.svg'
import cursorLight from '../assets/providers/cursor-light.svg'
import cursorAgent from '../assets/providers/cursor-agent.jpg'
import devin from '../assets/providers/devin.png'
import droid from '../assets/providers/droid.png'
import forge from '../assets/providers/forge.png'
import gemini from '../assets/providers/gemini.svg'
import goose from '../assets/providers/goose.png'
import grokDark from '../assets/providers/grok-dark.svg'
import grokLight from '../assets/providers/grok-light.svg'
import hermes from '../assets/providers/hermes.png'
import ibmBob from '../assets/providers/ibm-bob.svg'
import kiloCode from '../assets/providers/kilo-code.png'
import kimi from '../assets/providers/kimi.svg'
import kiro from '../assets/providers/kiro.png'
import mistralVibe from '../assets/providers/mistral-vibe.svg'
import mux from '../assets/providers/mux.png'
import openclaw from '../assets/providers/openclaw.jpg'
import opencodeDark from '../assets/providers/opencode-dark.svg'
import opencodeLight from '../assets/providers/opencode-light.svg'
import openaiDark from '../assets/providers/openai-dark.svg'
import openaiLight from '../assets/providers/openai-light.svg'
import pi from '../assets/providers/pi.png'
import qwenDark from '../assets/providers/qwen-dark.svg'
import qwenLight from '../assets/providers/qwen-light.svg'
import rooCode from '../assets/providers/roo-code.png'
import vercelGateway from '../assets/providers/vercel-gateway.png'
import warp from '../assets/providers/warp.jpg'
import zcode from '../assets/providers/zcode.jpg'
import zed from '../assets/providers/zed.jpg'
import zerostack from '../assets/providers/zerostack.png'

const SINGLE_LOGOS: Record<string, string> = {
  antigravity,
  claude,
  cline,
  codewhale,
  crush,
  'cursor-agent': cursorAgent,
  devin,
  droid,
  forge,
  gemini,
  goose,
  hermes,
  'ibm-bob': ibmBob,
  'kilo-code': kiloCode,
  kimi,
  kiro,
  'mistral-vibe': mistralVibe,
  mux,
  openclaw,
  pi,
  'roo-code': rooCode,
  'vercel-gateway': vercelGateway,
  warp,
  zcode,
  zed,
  zerostack,
}

const THEMED_LOGOS: Record<string, { light: string; dark: string }> = {
  codex: { light: openaiLight, dark: openaiDark },
  copilot: { light: copilotLight, dark: copilotDark },
  cursor: { light: cursorLight, dark: cursorDark },
  grok: { light: grokLight, dark: grokDark },
  opencode: { light: opencodeLight, dark: opencodeDark },
  qwen: { light: qwenLight, dark: qwenDark },
}

export function ProviderLogo({ provider, size = 16 }: { provider: string; size?: number }) {
  const singleLogo = SINGLE_LOGOS[provider]
  if (singleLogo) {
    return <img src={singleLogo} width={size} height={size} alt="" aria-hidden className="provider-logo" />
  }

  const logos = THEMED_LOGOS[provider]
  if (logos) {
    return <>
      <img src={logos.light} width={size} height={size} alt="" aria-hidden className="provider-logo pl-light" />
      <img src={logos.dark} width={size} height={size} alt="" aria-hidden className="provider-logo pl-dark" />
    </>
  }

  const initial = (provider.trim()[0] ?? '?').toUpperCase()
  return (
    <span
      className="provider-logo provider-mono"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.58) }}
      aria-hidden
    >{initial}</span>
  )
}
