/**
 * RouterCamera — implements the same public interface as FujiCamera,
 * but communicates with the filmkit-daemon HTTP API instead of WebUSB.
 *
 * Used when FilmKit is served from the GL.inet router (or accessed via ?router= param),
 * enabling operation on iOS/iPadOS/any browser without WebUSB support.
 */

import type { PresetData, RawProp } from './ptp/session.ts'
import type { LogFn } from './ptp/transport.ts'

// Shape of /api/presets response items
interface APIPresetProp {
  id: number
  name: string
  value: number | string
  bytes: string // base64-encoded in JSON (Go []byte → base64)
}

interface APIPreset {
  slot: number
  name: string
  settings: APIPresetProp[]
}

/** Decode a base64 string to Uint8Array (handles both standard and URL-safe base64). */
function b64ToBytes(b64: string): Uint8Array {
  // Go encodes []byte as standard base64 with padding
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export class RouterCamera {
  private baseUrl: string
  private log: LogFn

  connected = false
  modelName = ''
  rafLoaded = false
  baseProfile: Uint8Array | null = null
  /** True when camera is in Fuji RAW Conversion mode (presets + conversion available). */
  rawConversionMode = false

  // Filled after connect() — mirror FujiCamera API
  supportedProperties: Set<number> = new Set()

  constructor(baseUrl: string, log: LogFn = console.log) {
    // Normalise: strip trailing slash
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.log = log
  }

  get baseUrlPublic(): string { return this.baseUrl }

  private async api(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.baseUrl}${path}`
    const resp = await fetch(url, init)
    return resp
  }

  /** Connect to the camera via daemon API. */
  async connect(): Promise<{ ok: true } | { ok: false; error: string; detail: string }> {
    try {
      const resp = await this.api('/api/connect', { method: 'POST' })
      const json = await resp.json()

      if (!resp.ok) {
        this.log(`Router connect failed: ${json.error}`)
        return { ok: false, error: 'other', detail: json.error ?? 'unknown' }
      }

      this.connected = true
      this.modelName = json.model ?? 'Fujifilm camera'
      this.rafLoaded = json.rafLoaded ?? false
      this.rawConversionMode = json.rawConversion ?? false
      this.log(`Router: connected to ${this.modelName} (${this.rawConversionMode ? 'RAW Conversion' : 'Standard PTP'} mode)`)

      // Only mark preset properties as supported in RAW Conversion mode
      if (this.rawConversionMode) {
        for (let p = 0xD18C; p <= 0xD1A5; p++) this.supportedProperties.add(p)
      }

      return { ok: true }
    } catch (err) {
      return { ok: false, error: 'other', detail: String(err) }
    }
  }

  /** Disconnect from the camera. */
  async disconnect(): Promise<void> {
    try {
      await this.api('/api/disconnect', { method: 'POST' })
    } catch { /* best effort */ }
    this.connected = false
    this.rafLoaded = false
    this.baseProfile = null
  }

  /** Best-effort disconnect for page unload. */
  emergencyClose(): void {
    navigator.sendBeacon(`${this.baseUrl}/api/disconnect`)
  }

  /**
   * Upload a RAF file to the daemon, trigger conversion, download the JPEG.
   * Also fetches and caches the base profile for subsequent reconvert() calls.
   */
  async loadRaf(data: ArrayBuffer): Promise<Uint8Array> {
    this.log(`Router: uploading RAF (${(data.byteLength / 1024 / 1024).toFixed(1)} MB)...`)

    // Send as raw binary body — avoids multipart buffering on the router (tmpfs = RAM).
    // X-File-Size header tells the daemon the exact byte count for the PTP container.
    const resp = await this.api('/api/raf/load', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Size': String(data.byteLength),
      },
      body: data,
    })
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }))
      throw new Error(`loadRaf failed: ${err.error}`)
    }

    const jpeg = new Uint8Array(await resp.arrayBuffer())
    this.log(`Router: received ${(jpeg.length / 1024 / 1024).toFixed(1)} MB JPEG`)

    // Fetch and cache base profile for reconvert
    const profileResp = await this.api('/api/raf/profile')
    if (profileResp.ok) {
      this.baseProfile = new Uint8Array(await profileResp.arrayBuffer())
      this.log(`Router: cached base profile (${this.baseProfile.length} bytes)`)
    }

    this.rafLoaded = true
    return jpeg
  }

  /**
   * Re-convert the loaded RAF with new settings.
   * Patches the profile locally (same logic as FujiCamera) and sends raw bytes to daemon.
   */
  async reconvert(buildProfile: (base: Uint8Array) => Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    if (!this.rafLoaded || !this.baseProfile) {
      throw new Error('No RAF loaded — call loadRaf() first')
    }

    const modifiedProfile = buildProfile(this.baseProfile)
    this.log('Router: sending modified profile...')

    const resp = await this.api('/api/raf/reconvert-raw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: modifiedProfile,
    })

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }))
      throw new Error(`reconvert failed: ${err.error}`)
    }

    const jpeg = new Uint8Array(await resp.arrayBuffer())
    this.log(`Router: received ${(jpeg.length / 1024 / 1024).toFixed(1)} MB JPEG`)
    return jpeg
  }

  /** Scan all 7 preset slots from the camera via daemon. */
  async scanPresets(): Promise<PresetData[]> {
    const resp = await this.api('/api/presets')
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }))
      throw new Error(`scanPresets failed: ${err.error}`)
    }

    const apiPresets: APIPreset[] = await resp.json()

    return apiPresets.map(p => ({
      slot: p.slot,
      name: p.name,
      settings: p.settings.map(s => ({
        id: s.id,
        name: s.name,
        bytes: b64ToBytes(s.bytes),
        value: s.value,
      } satisfies RawProp)),
    } satisfies PresetData))
  }

  /** Write a preset to a camera slot via daemon. */
  async writePreset(
    slot: number,
    name: string,
    settings: RawProp[],
  ): Promise<{ ok: boolean; warnings: string[] }> {
    // Encode bytes as base64 for JSON transport
    const body = {
      name,
      settings: settings.map(s => ({
        id: s.id,
        bytes: btoa(String.fromCharCode(...s.bytes)),
      })),
    }

    const resp = await this.api(`/api/presets/${slot}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const json = await resp.json()
    if (!resp.ok) return { ok: false, warnings: [json.error ?? resp.statusText] }
    return { ok: json.ok, warnings: json.warnings ?? [] }
  }

  /** List RAF files on the camera's SD card. */
  async listCameraFiles(): Promise<{ handle: number; name: string; sizeMB: string }[]> {
    const resp = await this.api('/api/files')
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }))
      throw new Error(`listCameraFiles failed: ${err.error}`)
    }
    return resp.json()
  }

  /** Download a RAF file from the camera by its object handle. Returns raw bytes. */
  async downloadCameraFile(handle: number): Promise<ArrayBuffer> {
    const resp = await this.api(`/api/files/${handle}`)
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }))
      throw new Error(`downloadCameraFile failed: ${err.error}`)
    }
    return resp.arrayBuffer()
  }

  /** Lightweight liveness check. */
  async heartbeat(): Promise<void> {
    const resp = await this.api('/api/status')
    if (!resp.ok) throw new Error('heartbeat failed')
    const json = await resp.json()
    if (!json.connected) throw new Error('camera disconnected')
  }
}

// ==========================================================================
// Router mode detection
// ==========================================================================

/**
 * Determine the router API base URL.
 *
 * Priority:
 * 1. ?router=<ip> or ?router=<ip:port> URL parameter
 * 2. Auto-detect: if /api/status responds at current origin → served from daemon
 *
 * Returns null if not in router mode.
 */
export async function detectRouterBaseURL(): Promise<string | null> {
  const params = new URLSearchParams(window.location.search)
  const param = params.get('router')

  if (param) {
    if (param.startsWith('http')) return param
    const hasPort = /:\d+$/.test(param)
    return `http://${param}${hasPort ? '' : ':8765'}`
  }

  // Probe current origin — succeeds when served from filmkit-daemon
  try {
    const resp = await fetch('/api/status', {
      signal: AbortSignal.timeout(1500),
    })
    if (resp.ok) {
      const json = await resp.json()
      // Make sure it's our API (has the expected shape)
      if ('connected' in json) {
        return window.location.origin
      }
    }
  } catch { /* not served from daemon */ }

  return null
}
