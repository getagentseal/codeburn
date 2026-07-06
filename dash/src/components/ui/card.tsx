import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-lg border border-border bg-card', className)} {...props} />
}
