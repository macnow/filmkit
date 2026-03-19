/**
 * Fuzzy text parser for Fuji X Weekly recipe text and .filmkit JSON.
 *
 * Two-pass design:
 *   Pass 1 — labeled lines: regex-match known labels, apply field-specific value parsers.
 *   Pass 2 — unlabeled lines: try value parsers against unfilled fields in priority order
 *            (Film Sim → WB → DR → everything else).
 */

import {
  FilmSim, FilmSimLabels,
  WBMode, WBModeLabels,
  GrainStrength, GrainSize,
} from './profile/enums.ts'
import type { PresetUIValues } from './profile/preset-translate.ts'

// ── Types ──────────────────────────────────────────────────

export interface TextParseResult {
  /** Parsed values (may be partial — unfilled fields not included) */
  values: Partial<PresetUIValues>
  /** Lines successfully parsed, with the field(s) they set */
  recognized: { line: string, fields: string[] }[]
  /** Lines that couldn't be parsed */
  unrecognized: string[]
  /** Lines that matched a known-but-ignored label (like ISO) */
  ignored: string[]
}

// ── Helpers ────────────────────────────────────────────────

/** Normalize a string for fuzzy lookup: lowercase, strip non-alphanumeric */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// ── Film Simulation Lookup ─────────────────────────────────

const FILM_SIM_LOOKUP = new Map<string, number>()

// Build from canonical labels (e.g. "Provia (Standard)" → both full and short form)
for (const [val, label] of Object.entries(FilmSimLabels)) {
  const v = Number(val)
  FILM_SIM_LOOKUP.set(norm(label), v)
  // Short form: strip parenthetical e.g. "Provia (Standard)" → "Provia"
  const short = label.replace(/\s*\(.*\)/, '')
  if (short !== label) FILM_SIM_LOOKUP.set(norm(short), v)
}

// FXW aliases and common variations
const SIM_ALIASES: [string, number][] = [
  // Provia
  ['proviastd', FilmSim.Provia],
  ['standard', FilmSim.Provia],
  // Velvia
  ['vivid', FilmSim.Velvia],
  // Astia
  ['soft', FilmSim.Astia],
  // PRO Neg
  ['pronegativehi', FilmSim.ProNegHi],
  ['pronegativestd', FilmSim.ProNegStd],
  ['pronegativestd', FilmSim.ProNegStd],
  // Monochrome filter variants
  ['monochromeyellowfilter', FilmSim.MonochromeYe],
  ['monochromeredfilter', FilmSim.MonochromeR],
  ['monochromegreenfilter', FilmSim.MonochromeG],
  ['monoye', FilmSim.MonochromeYe],
  ['monor', FilmSim.MonochromeR],
  ['monog', FilmSim.MonochromeG],
  ['monoyellowfilter', FilmSim.MonochromeYe],
  ['monoredfilter', FilmSim.MonochromeR],
  ['monogreenfilter', FilmSim.MonochromeG],
  // Classic Chrome / Neg
  ['classicnegative', FilmSim.ClassicNeg],
  // Eterna
  ['eternacinema', FilmSim.Eterna],
  ['cinema', FilmSim.Eterna],
  ['eternableach', FilmSim.EternaBleach],
  ['bleachbypass', FilmSim.EternaBleach],
  // Nostalgic Neg
  ['nostalgicnegative', FilmSim.NostalgicNeg],
  // Acros filter variants
  ['acrosyellowfilter', FilmSim.AcrosYe],
  ['acrosredfilter', FilmSim.AcrosR],
  ['acrosgreenfilter', FilmSim.AcrosG],
]
for (const [alias, sim] of SIM_ALIASES) FILM_SIM_LOOKUP.set(alias, sim)

// ── WB Mode Lookup ─────────────────────────────────────────

const WB_LOOKUP = new Map<string, number>()
for (const [val, label] of Object.entries(WBModeLabels)) {
  WB_LOOKUP.set(norm(label), Number(val))
}
// Common aliases
const WB_ALIASES: [string, number][] = [
  ['auto', WBMode.Auto],
  ['daylight', WBMode.Daylight],
  ['sunny', WBMode.Daylight],
  ['cloudy', WBMode.Shade],
  ['shade', WBMode.Shade],
  ['tungsten', WBMode.Incandescent],
  ['incandescent', WBMode.Incandescent],
  ['fluorescent', WBMode.Fluorescent1],
  ['underwater', WBMode.Underwater],
  ['kelvin', WBMode.ColorTemp],
  ['colortemperature', WBMode.ColorTemp],
  ['colourtemperature', WBMode.ColorTemp],
]
for (const [alias, mode] of WB_ALIASES) WB_LOOKUP.set(alias, mode)

// ── Value Parsers ──────────────────────────────────────────

type ValueParser = (value: string) => Partial<PresetUIValues> | null

function parseFilmSimValue(value: string): Partial<PresetUIValues> | null {
  const sim = FILM_SIM_LOOKUP.get(norm(value))
  return sim !== undefined ? { filmSimulation: sim } : null
}

function parseWhiteBalanceValue(value: string): Partial<PresetUIValues> | null {
  const result: Partial<PresetUIValues> = {}
  let matched = false

  // Check for Kelvin temperature (e.g., "3100K", "6500 K")
  const kMatch = value.match(/(\d{3,5})\s*K\b/i)
  if (kMatch) {
    result.whiteBalance = WBMode.ColorTemp
    result.wbColorTemp = Number(kMatch[1])
    matched = true
  }

  // Check for WB mode name (only if no temp set it to ColorTemp)
  if (result.whiteBalance === undefined) {
    const modePart = value.split(/[,]/)[0].trim()
    const mode = WB_LOOKUP.get(norm(modePart))
    if (mode !== undefined) {
      result.whiteBalance = mode
      matched = true
    }
  }

  // Check for shifts: "+8 Red & -8 Blue" or "0 Red & 0 Blue"
  const shiftMatch = value.match(/([+-]?\d+)\s*Red\s*[&,]\s*([+-]?\d+)\s*Blue/i)
  if (shiftMatch) {
    result.wbShiftR = Number(shiftMatch[1])
    result.wbShiftB = Number(shiftMatch[2])
    matched = true
  }

  return matched ? result : null
}

function parseDRValue(value: string): Partial<PresetUIValues> | null {
  const v = value.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (v === 'DR100' || v === '100') return { dynamicRange: 1 }
  if (v === 'DR200' || v === '200') return { dynamicRange: 2 }
  if (v === 'DR400' || v === '400') return { dynamicRange: 3 }
  if (v === 'AUTO' || v === '0') return { dynamicRange: 0 }
  return null
}

function parseGrainValue(value: string): Partial<PresetUIValues> | null {
  const v = value.toLowerCase().trim()
  if (v === 'off') return { grainEffect: 0 }

  const strengthMatch = v.match(/\b(weak|strong)\b/)
  if (!strengthMatch) return null

  const strength = strengthMatch[1] === 'weak' ? GrainStrength.Weak : GrainStrength.Strong
  const sizeMatch = v.match(/\b(small|large)\b/)
  const size = sizeMatch?.[1] === 'large' ? GrainSize.Large : GrainSize.Small

  return { grainEffect: (size << 8) | strength }
}

/** Generic Off/Weak/Strong parser bound to a specific field */
function effectParser(field: keyof PresetUIValues): ValueParser {
  return (value: string) => {
    const v = value.toLowerCase().trim()
    if (v === 'off') return { [field]: 0 }
    if (v === 'weak') return { [field]: 1 }
    if (v === 'strong') return { [field]: 2 }
    return null
  }
}

function parseDRangePriorityValue(value: string): Partial<PresetUIValues> | null {
  const v = value.toLowerCase().trim()
  if (v === 'off') return { dRangePriority: 0 }
  if (v === 'auto') return { dRangePriority: 1 }
  if (v === 'weak') return { dRangePriority: 2 }
  if (v === 'strong') return { dRangePriority: 3 }
  return null
}

/** Parse a numeric value (integer or decimal, with optional leading +) */
function numericParser(field: keyof PresetUIValues): ValueParser {
  return (value: string) => {
    const n = parseFloat(value.trim())
    return isFinite(n) ? { [field]: n } : null
  }
}

/** Parse a fraction like "+2/3" or "-1/3", or a plain number */
function parseFraction(s: string): number | null {
  s = s.trim()
  const m = s.match(/^([+-]?\d+)\s*\/\s*(\d+)$/)
  if (m) return Number(m[1]) / Number(m[2])
  const n = parseFloat(s)
  return isFinite(n) ? n : null
}

function parseExposureValue(value: string): Partial<PresetUIValues> | null {
  // Strip parenthetical suffixes like "(typically)"
  let v = value.replace(/\(.*?\)/g, '').trim()
  // Strip "EV" suffix
  v = v.replace(/\s*ev\s*$/i, '').trim()
  // Split on "to" — take the last (second) value
  const parts = v.split(/\s+to\s+/i)
  const target = parts[parts.length - 1].trim()
  const n = parseFraction(target)
  return n !== null ? { exposure: n } : null
}

// ── Label Patterns (Pass 1) ────────────────────────────────
// Order matters: more specific patterns must come first.
// Each entry: [labelRegex, fieldKey or '_ignore', valueParser]

const LABEL_PATTERNS: [RegExp, string, ValueParser | null][] = [
  // Film simulation
  [/^film\s*sim(?:ulation)?\s*[:=\-]?\s*(.+)$/i, 'filmSimulation', parseFilmSimValue],
  // Color Chrome FX Blue (before Color Chrome — more specific)
  [/^colou?r\s*chrome\s*(?:effect\s*)?(?:fx\s*)?blue\s*[:=\-]?\s*(.+)$/i, 'colorChromeFxBlue', effectParser('colorChromeFxBlue')],
  // Color Chrome
  [/^colou?r\s*chrome(?:\s*effect)?\s*[:=\-]?\s*(.+)$/i, 'colorChrome', effectParser('colorChrome')],
  // D Range Priority (before Dynamic Range — more specific)
  [/^(?:d(?:ynamic)?\s*range\s*priority|wide\s*d(?:ynamic)?\s*range)\s*[:=\-]?\s*(.+)$/i, 'dRangePriority', parseDRangePriorityValue],
  // Dynamic Range
  [/^(?:dynamic\s*range|dr)\s*[:=\-]?\s*(.+)$/i, 'dynamicRange', parseDRValue],
  // Grain
  [/^grain(?:\s*effect)?\s*[:=\-]?\s*(.+)$/i, 'grainEffect', parseGrainValue],
  // Smooth Skin
  [/^smooth\s*skin\s*[:=\-]?\s*(.+)$/i, 'smoothSkin', effectParser('smoothSkin')],
  // White Balance (includes Color Temp / Kelvin aliases)
  [/^(?:white\s*balance|wb|colou?r\s*temp(?:erature)?|kelvin)\s*[:=\-]?\s*(.+)$/i, 'whiteBalance', parseWhiteBalanceValue],
  // Highlight Tone
  [/^highlight(?:s)?(?:\s*tone)?\s*[:=\-]?\s*(.+)$/i, 'highlightTone', numericParser('highlightTone')],
  // Shadow Tone
  [/^shadow(?:s)?(?:\s*tone)?\s*[:=\-]?\s*(.+)$/i, 'shadowTone', numericParser('shadowTone')],
  // Color (negative lookahead to avoid matching Color Chrome / Color Temp)
  [/^colou?r(?!\s*chrome)(?!\s*temp)\s*[:=\-]?\s*(.+)$/i, 'color', numericParser('color')],
  // Sharpness / Sharpening
  [/^(?:sharpness|sharpening)\s*[:=\-]?\s*(.+)$/i, 'sharpness', numericParser('sharpness')],
  // Noise Reduction / High ISO NR
  [/^(?:high\s*iso\s*(?:noise\s*reduction|nr)|noise\s*reduction|nr)\s*[:=\-]?\s*(.+)$/i, 'noiseReduction', numericParser('noiseReduction')],
  // Clarity
  [/^clarity\s*[:=\-]?\s*(.+)$/i, 'clarity', numericParser('clarity')],
  // Exposure Compensation
  [/^(?:exposure(?:\s*compensation)?|ev)\s*[:=\-]?\s*(.+)$/i, 'exposure', parseExposureValue],
  // Mono Warm/Cool
  [/^(?:mono(?:chrome)?\s*)?(?:warm\s*[/&]?\s*cool|wc)\s*[:=\-]?\s*(.+)$/i, 'monoWC', numericParser('monoWC')],
  // Mono Magenta/Green
  [/^(?:mono(?:chrome)?\s*)?(?:magenta\s*[/&]?\s*green|mg)\s*[:=\-]?\s*(.+)$/i, 'monoMG', numericParser('monoMG')],
  // Ignored fields
  [/^iso\s*[:=\-]?\s*(.+)$/i, '_ignore', null],
]

// ── Pass 2 Priority Order ──────────────────────────────────
// For unlabeled lines, try parsers in this order against unfilled fields.

const PASS2_ORDER: { field: keyof PresetUIValues, parser: ValueParser }[] = [
  { field: 'filmSimulation', parser: parseFilmSimValue },
  { field: 'whiteBalance', parser: parseWhiteBalanceValue },
  { field: 'dynamicRange', parser: parseDRValue },
  { field: 'grainEffect', parser: parseGrainValue },
  { field: 'colorChrome', parser: effectParser('colorChrome') },
  { field: 'colorChromeFxBlue', parser: effectParser('colorChromeFxBlue') },
  { field: 'smoothSkin', parser: effectParser('smoothSkin') },
  { field: 'dRangePriority', parser: parseDRangePriorityValue },
  { field: 'highlightTone', parser: numericParser('highlightTone') },
  { field: 'shadowTone', parser: numericParser('shadowTone') },
  { field: 'color', parser: numericParser('color') },
  { field: 'sharpness', parser: numericParser('sharpness') },
  { field: 'noiseReduction', parser: numericParser('noiseReduction') },
  { field: 'clarity', parser: numericParser('clarity') },
  { field: 'exposure', parser: parseExposureValue },
  { field: 'monoWC', parser: numericParser('monoWC') },
  { field: 'monoMG', parser: numericParser('monoMG') },
]

// ── Main Parser ────────────────────────────────────────────

export function parseTextPreset(text: string): TextParseResult {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0)

  const values: Partial<PresetUIValues> = {}
  const recognized: { line: string, fields: string[] }[] = []
  const unrecognized: string[] = []
  const ignored: string[] = []
  const filledFields = new Set<string>()

  // Lines that didn't match any label pattern → candidates for pass 2
  const unmatchedLines: string[] = []

  // ── Pass 1: Labeled lines ──
  for (const line of lines) {
    let matched = false

    for (const [regex, fieldKey, parser] of LABEL_PATTERNS) {
      const m = line.match(regex)
      if (!m) continue

      matched = true
      const rawValue = m[1].trim()

      if (fieldKey === '_ignore') {
        ignored.push(line)
        break
      }

      if (!parser) break

      const parsed = parser(rawValue)
      if (parsed) {
        const fields: string[] = []
        for (const [k, v] of Object.entries(parsed)) {
          ;(values as Record<string, number>)[k] = v
          filledFields.add(k)
          fields.push(k)
        }
        recognized.push({ line, fields })
      } else {
        // Label matched but value didn't parse — unrecognized
        unrecognized.push(line)
      }
      break
    }

    if (!matched) {
      unmatchedLines.push(line)
    }
  }

  // ── Pass 2: Unlabeled lines ──
  for (const line of unmatchedLines) {
    let matched = false

    for (const { field, parser } of PASS2_ORDER) {
      // Skip if this field's primary key is already filled
      if (filledFields.has(field)) continue

      const parsed = parser(line)
      if (parsed) {
        const fields: string[] = []
        for (const [k, v] of Object.entries(parsed)) {
          ;(values as Record<string, number>)[k] = v
          filledFields.add(k)
          fields.push(k)
        }
        recognized.push({ line, fields })
        matched = true
        break
      }
    }

    if (!matched) {
      unrecognized.push(line)
    }
  }

  return { values, recognized, unrecognized, ignored }
}

// ── Human-readable field names (for summary display) ───────

export const FIELD_LABELS: Record<string, string> = {
  filmSimulation: 'Film Simulation',
  dynamicRange: 'Dynamic Range',
  grainEffect: 'Grain Effect',
  smoothSkin: 'Smooth Skin',
  colorChrome: 'Color Chrome',
  colorChromeFxBlue: 'Color Chrome FX Blue',
  whiteBalance: 'White Balance',
  wbShiftR: 'WB Shift Red',
  wbShiftB: 'WB Shift Blue',
  wbColorTemp: 'WB Color Temp',
  highlightTone: 'Highlight',
  shadowTone: 'Shadow',
  color: 'Color',
  sharpness: 'Sharpness',
  noiseReduction: 'Noise Reduction',
  clarity: 'Clarity',
  exposure: 'Exposure',
  dRangePriority: 'D Range Priority',
  monoWC: 'Mono WC',
  monoMG: 'Mono MG',
}
