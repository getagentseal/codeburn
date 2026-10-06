import type { Boot } from '../../app/renderer/vscode/bridge'

/**
 * The page around a built webview entry. Scripts and styles load only from the
 * extension's own files; the boot data rides in a JSON block, which is never
 * executed, so there is no inline script for the policy to allow.
 */
export function webviewHtml(opts: { cspSource: string; scriptUri: string; styleUri: string; boot: Boot; title: string; lang: string }): string {
  const csp = [
    "default-src 'none'",
    `script-src ${opts.cspSource}`,
    // React sets style attributes (bar widths, popover positions).
    `style-src ${opts.cspSource} 'unsafe-inline'`,
    `img-src ${opts.cspSource} data:`,
    `media-src ${opts.cspSource}`,
    `font-src ${opts.cspSource}`,
  ].join('; ')
  const boot = JSON.stringify(opts.boot).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="${escapeAttr(opts.lang)}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeAttr(opts.title)}</title>
<link rel="stylesheet" href="${escapeAttr(opts.styleUri)}">
<script type="application/json" id="codeburn-boot">${boot}</script>
<script type="module" src="${escapeAttr(opts.scriptUri)}"></script>
</head>
<body>
<div id="root"></div>
</body>
</html>`
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
