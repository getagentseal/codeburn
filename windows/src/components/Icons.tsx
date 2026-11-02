import type { SVGProps } from 'react'

/// Small stroke icons standing in for the SF Symbols the macOS app uses. All are drawn on
/// a 16x16 grid at 1.5px stroke so they sit on the same optical baseline as 11px text.

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Svg({ size = 12, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const FLAME_PATH = 'M8 1.5c.4 2.2 1.9 3.3 3.1 4.6C12.4 7.5 13 8.9 13 10.3 13 13 10.8 15 8 15s-5-2-5-4.7c0-1.6.7-2.8 1.5-3.7.2 1 .8 1.8 1.6 2.2C6 7 6.6 4.5 8 1.5z'

export function FlameIcon({ filled = false, ...p }: IconProps & { filled?: boolean }) {
  return <Svg {...p}><path d={FLAME_PATH} fill={filled ? 'currentColor' : 'none'} /></Svg>
}

export function ChevronRight(p: IconProps) {
  return <Svg {...p}><path d="M6 3.5 10.5 8 6 12.5" /></Svg>
}

export function RetryIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 6.5A5 5 0 0 1 12 5.4M13.5 9.5A5 5 0 0 1 4 10.6" />
      <path d="M12.5 2.5v3h-3M3.5 13.5v-3h3" />
    </Svg>
  )
}

export function RouteIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 5h8.5M2.5 11h8.5" />
      <path d="M9 2.5 11.5 5 9 7.5M5 8.5 2.5 11 5 13.5" />
    </Svg>
  )
}

export function PersonCircleIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="6.5" r="2" />
      <path d="M4 13a4.2 4.2 0 0 1 8 0" />
    </Svg>
  )
}

export function MonitorIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="2" y="3" width="12" height="8" rx="1.5" />
      <path d="M6 13.5h4" />
    </Svg>
  )
}

export function LeafIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M13.5 2.5c0 6.1-3.1 9.5-7.3 9.5A3.7 3.7 0 0 1 2.5 8.3c0-4 3.6-5.8 11-5.8z" fill="currentColor" stroke="none" />
      <path d="M11 5 3.5 13" />
    </Svg>
  )
}

export function ChevronLeft(p: IconProps) {
  return <Svg {...p}><path d="M10 3.5 5.5 8 10 12.5" /></Svg>
}

export function CalendarIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
      <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
    </Svg>
  )
}

export function ChevronDown(p: IconProps) {
  return <Svg {...p}><path d="M3.5 6 8 10.5 12.5 6" /></Svg>
}

export function RefreshIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 2.5v3h-3" />
    </Svg>
  )
}

export function DownloadIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 2.5v8M5 7.5l3 3 3-3" />
      <path d="M3 11.5v1.5a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5v-1.5" />
    </Svg>
  )
}

export function TerminalIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M4.5 6.5 6.5 8l-2 1.5M8 10h3" />
    </Svg>
  )
}

export function CoinIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5v7M10 6.2c-.3-.7-1-1-2-1s-2 .5-2 1.3c0 1.9 4 .9 4 2.9 0 .8-1 1.3-2 1.3s-1.8-.4-2.1-1" />
    </Svg>
  )
}

export function XIcon(p: IconProps) {
  return <Svg {...p}><path d="M4 4l8 8M12 4l-8 8" /></Svg>
}

export function BulbIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M5.5 11.5a4.5 4.5 0 1 1 5 0v1.5h-5z" fill="currentColor" stroke="none" />
      <path d="M6.5 14.5h3" />
    </Svg>
  )
}

export function CheckCircleIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="6" fill="currentColor" stroke="none" />
      <path d="M5.3 8.2 7.2 10l3.5-4" stroke="var(--icon-contrast, #fff)" />
    </Svg>
  )
}

export function ArrowUpRightCircleIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="6" fill="currentColor" stroke="none" />
      <path d="M6 10l4-4M6.5 6H10v3.5" stroke="var(--icon-contrast, #fff)" />
    </Svg>
  )
}

export function WarningIcon({ filled = true, ...p }: IconProps & { filled?: boolean }) {
  return (
    <Svg {...p}>
      <path d="M8 2.2 14.3 13H1.7z" fill={filled ? 'currentColor' : 'none'} />
      <path d="M8 6.2v3.3M8 11.3v.2" stroke={filled ? 'var(--icon-contrast, #fff)' : 'currentColor'} />
    </Svg>
  )
}

/// The rest of the severity ladder the quota warning row climbs, standing in for the mac's
/// info.circle, exclamationmark.circle and octagon (WarningIcon covers the triangle).
export function InfoCircleIcon(p: IconProps) {
  return <Svg {...p}><circle cx="8" cy="8" r="6" /><path d="M8 7.3v3.4M8 5.2v.2" /></Svg>
}

export function ExclamationCircleIcon(p: IconProps) {
  return <Svg {...p}><circle cx="8" cy="8" r="6" /><path d="M8 5.1v3.5M8 10.7v.2" /></Svg>
}

export function OctagonIcon(p: IconProps) {
  return <Svg {...p}><path d="M5.9 2h4.2L13 4.9v4.2L10.1 12H5.9L3 9.1V4.9z" /></Svg>
}

export function ArrowUpRight(p: IconProps) {
  return <Svg {...p}><path d="M4.5 11.5 11.5 4.5M6 4.5h5.5V10" /></Svg>
}

export function ArrowDownRight(p: IconProps) {
  return <Svg {...p}><path d="M4.5 4.5 11.5 11.5M6 11.5h5.5V6" /></Svg>
}

export function ArrowForward(p: IconProps) {
  return <Svg {...p}><path d="M3 8h10M9 4l4 4-4 4" /></Svg>
}

export function KeySlashIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="5.5" cy="6.5" r="3" />
      <path d="M8 8.5 13.5 14M11 11.5l1.5-1.5M2 14 14 2" />
    </Svg>
  )
}

export function PersonDashedIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="6.5" strokeDasharray="2.2 2" />
      <circle cx="8" cy="6.5" r="2" />
      <path d="M4.8 12.2c.6-1.6 1.8-2.4 3.2-2.4s2.6.8 3.2 2.4" />
    </Svg>
  )
}

export function TrayIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 9.5h3.2l.8 1.5h3l.8-1.5h3.2" />
      <path d="M2.5 9.5 4 4.5h8l1.5 5v3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
    </Svg>
  )
}

export function EllipsisIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="3.5" cy="8" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="1.2" fill="currentColor" stroke="none" />
    </Svg>
  )
}

/// pencil.line, for the Pulse cost-per-edit caption.
export function PencilLineIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M10.5 2.8 13.2 5.5 6.4 12.3 3.2 13l.7-3.2z" />
      <path d="M2.5 14.5h11" />
    </Svg>
  )
}

export function CheckIcon(p: IconProps) {
  return <Svg {...p}><path d="M3.5 8.5 6.5 11.5 12.5 5" /></Svg>
}

/// doc.on.doc, for the copyable command in the CLI update banner.
export function CopyIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.5a1.5 1.5 0 0 0-1.5-1.5H4a1.5 1.5 0 0 0-1.5 1.5V9a1.5 1.5 0 0 0 1.5 1.5" />
    </Svg>
  )
}
