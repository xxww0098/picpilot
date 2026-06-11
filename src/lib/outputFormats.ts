import type { OutputImageFormat } from '../types'

export const DEFAULT_ALLOWED_OUTPUT_FORMATS: OutputImageFormat[] = ['jpeg', 'png', 'webp']

export const OUTPUT_FORMAT_OPTIONS: Array<{ label: string; value: OutputImageFormat }> = [
  { label: 'JPEG', value: 'jpeg' },
  { label: 'PNG', value: 'png' },
  { label: 'WebP', value: 'webp' },
]

const OUTPUT_FORMAT_VALUES = new Set<OutputImageFormat>(['png', 'jpeg', 'webp'])

export function normalizeOutputFormat(value: unknown): OutputImageFormat | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (normalized === 'jpg') return 'jpeg'
  return OUTPUT_FORMAT_VALUES.has(normalized as OutputImageFormat) ? normalized as OutputImageFormat : null
}

export function normalizeAllowedOutputFormats(value: unknown, fallback: readonly OutputImageFormat[] = DEFAULT_ALLOWED_OUTPUT_FORMATS): OutputImageFormat[] {
  if (!Array.isArray(value)) return [...fallback]
  const out: OutputImageFormat[] = []
  for (const item of value) {
    const format = normalizeOutputFormat(item)
    if (!format || out.includes(format)) continue
    out.push(format)
  }
  return out.length ? out : [...fallback]
}

export function resolveAllowedOutputFormat(value: unknown, allowedFormats: readonly OutputImageFormat[]): OutputImageFormat {
  const allowed = normalizeAllowedOutputFormats(allowedFormats)
  const requested = normalizeOutputFormat(value)
  if (requested && allowed.includes(requested)) return requested
  return allowed[0]
}

export function getOutputFormatSelectOptions(allowedFormats: unknown) {
  const allowed = normalizeAllowedOutputFormats(allowedFormats)
  return OUTPUT_FORMAT_OPTIONS.filter((option) => allowed.includes(option.value))
}

export function formatOutputFormatList(allowedFormats: unknown): string {
  const allowed = normalizeAllowedOutputFormats(allowedFormats)
  return OUTPUT_FORMAT_OPTIONS
    .filter((option) => allowed.includes(option.value))
    .map((option) => option.label)
    .join(' / ')
}
