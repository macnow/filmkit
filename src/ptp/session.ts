/**
 * Fujifilm camera session — high-level operations over PTP.
 *
 * This is the port of rawji's FujiCamera class (fuji_usb.py).
 * Phase 1 implements: connect, openSession, closeSession.
 * Phases 2-3 will add: sendRaf, getProfile, setProfile, triggerConversion, waitForResult.
 */

import { USBTransport, type LogFn } from './transport.ts'
import { PTPOp, PTPResp, FujiOp, FujiProp, FujiPropNames, respName } from './constants.ts'
import { packU16, packU32, packPTPString, concat, PTPReader, parsePTPStringRaw } from '../util/binary.ts'

// ==========================================================================
// Types for device inspection
// ==========================================================================

export interface DeviceInfo {
  model: string
  serialNumber: string
  manufacturer: string
  deviceVersion: string
  properties: number[]
  operations: number[]
}

export interface RawProp {
  id: number
  name: string
  bytes: Uint8Array
  /** Decoded: int16 for 2-byte, uint32 for 4-byte, PTP string if starts with valid length byte */
  value: number | string
}

export interface PresetData {
  slot: number
  name: string
  settings: RawProp[]
}

// ==========================================================================
// Command queue — serializes camera I/O, latest-wins for renders
// ==========================================================================

/** Thrown when a queued action is superseded (e.g. a newer render replaces a pending one). */
export class CancelledError extends Error {
  constructor() { super('Cancelled') }
}

type QueueTag = 'render' | 'default'

interface QueueItem {
  tag: QueueTag
  fn: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

/** Smart-decode raw property bytes: PTP string, int16, uint32, or hex */
function decodePropValue(data: Uint8Array): number | string {
  // Try PTP string: first byte = numChars, followed by UCS-2LE
  // Heuristic: if length ≥ 3 and first byte × 2 + 1 ≈ total length, it's a string
  if (data.length >= 3) {
    const numChars = data[0]
    const expectedLen = 1 + numChars * 2
    if (numChars >= 2 && (expectedLen === data.length || expectedLen === data.length + 1)) {
      return parsePTPStringRaw(data)
    }
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  // 2 bytes → int16 LE (most common for Fuji properties)
  if (data.length === 2) return view.getInt16(0, true)

  // 4 bytes → int32 LE
  if (data.length === 4) return view.getInt32(0, true)

  // 1 byte
  if (data.length === 1) return data[0]

  // Fallback: hex dump
  return '0x' + Array.from(data.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export class FujiCamera {
  private transport: USBTransport
  private log: LogFn
  private sessionOpen = false

  /** Camera model name from PTP DeviceInfo (e.g. "X100VI") */
  modelName = ''
  /** Base profile from the camera (cached after first RAF upload) */
  baseProfile: Uint8Array | null = null
  /** Whether a RAF is currently loaded in camera memory */
  rafLoaded = false

  // Command queue — serializes all camera I/O
  private queue: QueueItem[] = []
  private draining = false

  constructor(log: LogFn = console.log) {
    this.log = log
    this.transport = new USBTransport(log)
  }

  /**
   * Enqueue a camera action. Only one action runs at a time.
   * Tag 'render' enables latest-wins: pending renders are cancelled when a new one arrives.
   */
  private enqueue<T>(tag: QueueTag, fn: () => Promise<T>): Promise<T> {
    if (tag === 'render') {
      // Latest-wins: cancel any pending renders
      for (let i = this.queue.length - 1; i >= 0; i--) {
        if (this.queue[i].tag === 'render') {
          this.queue[i].reject(new CancelledError())
          this.queue.splice(i, 1)
        }
      }
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({ tag, fn, resolve: resolve as (v: unknown) => void, reject })
      if (!this.draining) this.drain()
    })
  }

  private async drain(): Promise<void> {
    this.draining = true
    while (this.queue.length > 0) {
      const item = this.queue.shift()!
      try {
        const result = await item.fn()
        item.resolve(result)
      } catch (err) {
        item.reject(err)
      }
    }
    this.draining = false
  }

  /** Cancel all pending queue items (used on disconnect). */
  private clearQueue(): void {
    for (const item of this.queue) {
      item.reject(new CancelledError())
    }
    this.queue = []
  }

  get connected(): boolean {
    return this.transport.device !== null
  }

  get deviceName(): string {
    return this.transport.device?.productName ?? 'Unknown camera'
  }

  /** Connect to camera (opens USB device + PTP session) */
  async connect(): Promise<{ ok: true } | { ok: false, error: string }> {
    const result = await this.transport.connect()
    if (!result.ok) return result

    if (!await this.openSession()) return { ok: false, error: 'other' }

    // Fetch model name from PTP DeviceInfo
    try {
      const info = await this.getDeviceInfo()
      this.modelName = info.model
    } catch {
      // Non-fatal — fall back to USB product name
      this.modelName = this.transport.device?.productName ?? 'Unknown camera'
    }
    return { ok: true }
  }

  /** Best-effort session close for page unload — fire and forget, no await. */
  emergencyClose(): void {
    if (this.sessionOpen) {
      this.transport.fireCloseSession()
    }
  }

  /** Disconnect (close session + release USB). Cancels all pending queue items. */
  async disconnect(): Promise<void> {
    this.clearQueue()
    if (this.sessionOpen) {
      await this.closeSession()
    }
    await this.transport.disconnect()
  }

  private async openSession(): Promise<boolean> {
    this.log('Opening PTP session...')

    const sessionId = 1
    const { code } = await this.transport.sendCommand(PTPOp.OpenSession, [sessionId])

    if (code === PTPResp.OK) {
      this.sessionOpen = true
      this.log('Session opened')
      return true
    }

    if (code === PTPResp.SessionAlreadyOpen) {
      // Stale session from a previous page load. CloseSession clears the
      // camera's PTP state, but the transport is left confused (transaction
      // IDs out of sync). Reset the USB connection after closing so the
      // retry starts with a clean transport — same as a manual reconnect.
      this.log('Stale session detected, closing and resetting...')
      try {
        await this.transport.sendCommand(PTPOp.CloseSession)
      } catch {
        // Ignore — best-effort
      }
      await this.transport.resetConnection()
      const retry = await this.transport.sendCommand(PTPOp.OpenSession, [sessionId])
      if (retry.code === PTPResp.OK) {
        this.sessionOpen = true
        this.log('Session opened')
        return true
      }
      this.log(`OpenSession failed after reset: ${respName(retry.code)}`)
      return false
    }

    this.log(`OpenSession failed: ${respName(code)}`)
    return false
  }

  private async closeSession(): Promise<void> {
    this.log('Closing session...')
    try {
      const { code } = await this.transport.sendCommand(PTPOp.CloseSession)
      if (code === PTPResp.OK) {
        this.log('Session closed')
      }
    } catch {
      // Ignore errors on close
    }
    this.sessionOpen = false
  }

  // ==========================================================================
  // Device inspection — enumerate & read camera properties
  // ==========================================================================

  /** Read PTP DeviceInfo to discover supported operations and properties */
  async getDeviceInfo(): Promise<DeviceInfo> {
    const { code, data } = await this.transport.sendCommand(PTPOp.GetDeviceInfo)
    if (code !== PTPResp.OK) {
      throw new Error(`GetDeviceInfo failed: ${respName(code)}`)
    }

    const r = new PTPReader(data)
    r.u16()       // StandardVersion
    r.u32()       // VendorExtensionID
    r.u16()       // VendorExtensionVersion
    r.str()       // VendorExtensionDesc
    r.u16()       // FunctionalMode

    const operations = r.u16array()
    r.u16array()  // EventsSupported
    const properties = r.u16array()
    r.u16array()  // CaptureFormats
    r.u16array()  // ImageFormats

    const manufacturer = r.str()
    const model = r.str()
    const deviceVersion = r.str()
    const serialNumber = r.str()

    this.log(`${model} (${deviceVersion}), ${properties.length} properties supported`)
    return { model, serialNumber, manufacturer, deviceVersion, properties, operations }
  }

  /** Read a single property value (GetDevicePropValue), smart-decoded */
  async readProp(propId: number): Promise<RawProp | null> {
    try {
      const { code, data } = await this.transport.sendCommand(
        PTPOp.GetDevicePropValue, [propId],
      )
      if (code !== PTPResp.OK || data.length === 0) return null

      const name = FujiPropNames[propId] ?? `0x${propId.toString(16).toUpperCase()}`
      return { id: propId, name, bytes: data, value: decodePropValue(data) }
    } catch {
      return null
    }
  }

  /** Write a uint16 value to a device property */
  async writePropU16(propId: number, value: number): Promise<boolean> {
    const data = packU16(value) as Uint8Array<ArrayBuffer>
    const { code } = await this.transport.sendDataCommand(
      PTPOp.SetDevicePropValue, [propId], data,
    )
    return code === PTPResp.OK
  }

  /** Write raw bytes to a device property */
  async writePropRaw(propId: number, bytes: Uint8Array): Promise<boolean> {
    const data = new Uint8Array(bytes) as Uint8Array<ArrayBuffer>
    const { code } = await this.transport.sendDataCommand(
      PTPOp.SetDevicePropValue, [propId], data,
    )
    return code === PTPResp.OK
  }

  /** Write a PTP string to a device property */
  async writePropString(propId: number, value: string): Promise<boolean> {
    const data = packPTPString(value) as Uint8Array<ArrayBuffer>
    const { code } = await this.transport.sendDataCommand(
      PTPOp.SetDevicePropValue, [propId], data,
    )
    return code === PTPResp.OK
  }

  /**
   * Write a complete preset to a camera slot with verification.
   * Returns { ok, errors }. Errors list any properties that failed to write or verify.
   */
  /**
   * Write a complete preset to a camera slot with verification.
   * Returns { ok, warnings }. Write failures on individual properties are
   * non-fatal warnings (some properties like D19C, D19F, D1A1 are read-only).
   * Only slot selection or name write failure is fatal.
   */
  async writePreset(
    slot: number,
    name: string,
    settings: RawProp[],
  ): Promise<{ ok: boolean; warnings: string[] }> {
    return this.enqueue('default', async () => {
      const warnings: string[] = []

      // 1. Select slot — fatal if fails
      if (!await this.writePropU16(0xD18C, slot)) {
        return { ok: false, warnings: ['Failed to select slot'] }
      }
      await new Promise(r => setTimeout(r, 100))

      // 2. Write name — fatal if fails
      if (!await this.writePropString(0xD18D, name)) {
        return { ok: false, warnings: ['Failed to write preset name'] }
      }

      // 3. Write all settings — track which succeeded for verification
      // Conditional properties (D193/D194, D19C, D19F) are already excluded
      // by translateUIToPresetProps() when they shouldn't be written.
      const written = new Set<number>()
      for (const s of settings) {
        const ok = await this.writePropRaw(s.id, s.bytes)
        if (ok) {
          written.add(s.id)
        } else {
          const propName = FujiPropNames[s.id] ?? '0x' + s.id.toString(16)
          const hex = Array.from(s.bytes).map(b => b.toString(16).padStart(2, '0')).join(' ')
          warnings.push(`${propName}: write rejected [${hex}]`)
        }
      }

      // 4. Verify name
      const verifyName = await this.readProp(0xD18D)
      if (verifyName && typeof verifyName.value === 'string' && verifyName.value !== name) {
        return { ok: false, warnings: [`Name verify failed: wrote "${name}" read "${verifyName.value}"`] }
      }

      // 5. Verify only successfully written properties
      for (const s of settings) {
        if (!written.has(s.id)) continue
        const rb = await this.readProp(s.id)
        if (!rb) continue
        if (s.bytes.length === rb.bytes.length) {
          let match = true
          for (let i = 0; i < s.bytes.length; i++) {
            if (s.bytes[i] !== rb.bytes[i]) { match = false; break }
          }
          if (!match) {
            const propName = FujiPropNames[s.id] ?? '0x' + s.id.toString(16)
            return { ok: false, warnings: [`${propName}: verify mismatch after successful write`] }
          }
        }
      }

      this.log(`Slot ${slot}: wrote ${written.size}/${settings.length} properties`)
      return { ok: true, warnings }
    })
  }

  /** Lightweight read to check if camera is still connected. Enqueued to avoid USB conflicts. */
  async heartbeat(): Promise<void> {
    return this.enqueue('default', async () => {
      const prop = await this.readProp(0xD212)
      if (!prop) throw new Error('heartbeat failed')
    })
  }

  /** Scan all Fuji vendor properties (uses GetDevicePropValue) */
  async scanProperties(): Promise<RawProp[]> {
    return this.enqueue('default', async () => {
      const info = await this.getDeviceInfo()
      const fujiProps = info.properties.filter(p => p >= 0xD000)
      this.log(`Scanning ${fujiProps.length} Fuji properties...`)

      const results: RawProp[] = []
      for (const propId of fujiProps) {
        if (propId === FujiProp.RawConvProfile) continue
        const prop = await this.readProp(propId)
        if (prop) results.push(prop)
      }

      this.log(`Read ${results.length} properties`)
      return results
    })
  }

  /**
   * Scan all 7 custom presets (C1-C7).
   *
   * Hypothesis: D18C selects the preset slot, D18D-D1A5 hold its settings.
   * We cycle D18C through 1-7, reading the settings for each slot.
   */
  async scanPresets(): Promise<PresetData[]> {
    return this.enqueue('default', async () => {
      // Save current slot so we can restore it
      const origSlot = await this.readProp(0xD18C)
      const origSlotVal = origSlot && typeof origSlot.value === 'number' ? origSlot.value : 1

      const presets: PresetData[] = []

      for (let slot = 1; slot <= 7; slot++) {
        const ok = await this.writePropU16(0xD18C, slot)
        if (!ok) {
          this.log(`Failed to select slot ${slot}`)
          continue
        }

        await new Promise(r => setTimeout(r, 100))

        const nameProp = await this.readProp(0xD18D)
        const name = nameProp && typeof nameProp.value === 'string' ? nameProp.value : `(slot ${slot})`

        const settings: RawProp[] = []
        for (let pid = 0xD18E; pid <= 0xD1A5; pid++) {
          const prop = await this.readProp(pid)
          if (prop) settings.push(prop)
        }

        presets.push({ slot, name, settings })
        this.log(`C${slot}: "${name}" (${settings.length} settings)`)
      }

      await this.writePropU16(0xD18C, origSlotVal)
      return presets
    })
  }

  // ==========================================================================
  // Phase 2: RAF Upload + Profile Read
  // ==========================================================================

  /**
   * Upload a RAF file to the camera.
   *
   * Two-step process using Fuji vendor commands:
   * 1. SendObjectInfo (0x900C) — tells camera about the incoming file
   * 2. SendObject2 (0x900D) — sends the actual RAF data
   *
   * The ObjectInfo structure must match what the camera expects exactly —
   * wrong ObjectFormat (e.g., 0x5000 instead of 0xF802) causes silent failure.
   */
  async sendRaf(data: ArrayBuffer): Promise<void> {
    const sizeMB = (data.byteLength / 1024 / 1024).toFixed(1)
    this.log(`Sending RAF file (${sizeMB} MB)...`)

    // Build PTP ObjectInfo structure
    const objectInfo = concat(
      packU32(0),              // StorageID
      packU16(0xF802),         // ObjectFormat — MUST be 0xF802 for RAF
      packU16(0),              // ProtectionStatus
      packU32(data.byteLength),// CompressedSize
      packU16(0),              // ThumbFormat
      packU32(0),              // ThumbCompressedSize
      packU32(0),              // ThumbPixWidth
      packU32(0),              // ThumbPixHeight
      packU32(0),              // ImagePixWidth
      packU32(0),              // ImagePixHeight
      packU32(0),              // ImageBitDepth
      packU32(0),              // ParentObject
      packU16(0),              // AssociationType
      packU32(0),              // AssociationDesc
      packU32(0),              // SequenceNumber
      packPTPString('FUP_FILE.dat'), // Filename
      new Uint8Array([0]),     // CaptureDate (empty)
      new Uint8Array([0]),     // ModificationDate (empty)
      new Uint8Array([0]),     // Keywords (empty)
    )

    // Step 1: Send ObjectInfo
    this.log('Sending object info...')
    const infoResult = await this.transport.sendDataCommand(
      FujiOp.SendObjectInfo,
      [0, 0, 0], // storage_id, handle, 0
      objectInfo,
    )
    if (infoResult.code !== PTPResp.OK) {
      throw new Error(`SendObjectInfo failed: ${respName(infoResult.code)}`)
    }

    // Step 2: Send RAF data
    this.log('Uploading RAF data...')
    const sendResult = await this.transport.sendDataCommand(
      FujiOp.SendObject2,
      [],
      new Uint8Array(data),
      60_000, // 60s timeout for large files
    )
    if (sendResult.code !== PTPResp.OK) {
      throw new Error(`SendObject failed: ${respName(sendResult.code)}`)
    }

    this.log('RAF file uploaded')
  }

  /**
   * Read the current RAW conversion profile from the camera (property 0xD185).
   *
   * This returns the camera's d185 binary profile — a 605-byte or 632-byte
   * structure containing all current conversion parameters.
   * The camera needs a RAF loaded first for this to return valid data.
   */
  async getProfile(): Promise<Uint8Array> {
    this.log('Reading profile from camera...')

    const { code, data } = await this.transport.sendCommand(
      PTPOp.GetDevicePropValue,
      [FujiProp.RawConvProfile],
    )

    if (code !== PTPResp.OK) {
      throw new Error(`GetDevicePropValue(0xD185) failed: ${respName(code)}`)
    }

    if (data.length === 0) {
      throw new Error('Profile data is empty — is a RAF file loaded?')
    }

    this.log(`Profile received: ${data.length} bytes`)
    return data
  }

  // ==========================================================================
  // Phase 3: Profile Write + Conversion
  // ==========================================================================

  /** Send a modified profile to the camera (property 0xD185) */
  async setProfile(profile: Uint8Array<ArrayBuffer>): Promise<void> {
    this.log(`Sending modified profile (${profile.length} bytes)...`)

    const { code } = await this.transport.sendDataCommand(
      PTPOp.SetDevicePropValue,
      [FujiProp.RawConvProfile],
      profile,
    )

    if (code !== PTPResp.OK) {
      throw new Error(`SetDevicePropValue(0xD185) failed: ${respName(code)}`)
    }

    this.log('Profile sent')
  }

  /** Trigger RAW conversion (set property 0xD183 to 0) */
  async triggerConversion(): Promise<void> {
    this.log('Triggering conversion...')

    const data = packU16(0) as Uint8Array<ArrayBuffer>
    const { code } = await this.transport.sendDataCommand(
      PTPOp.SetDevicePropValue,
      [FujiProp.StartRawConversion],
      data,
    )

    if (code !== PTPResp.OK) {
      throw new Error(`StartRawConversion failed: ${respName(code)}`)
    }

    this.log('Conversion started')
  }

  /**
   * Poll for the converted JPEG and download it.
   *
   * After triggering conversion, the camera processes the RAF and creates
   * a temporary JPEG object. We poll GetObjectHandles until it appears,
   * download it, then delete the temp object.
   */
  async waitForResult(timeoutMs = 30_000): Promise<Uint8Array> {
    this.log('Waiting for result...')
    const start = Date.now()

    while (Date.now() - start < timeoutMs) {
      const { code, data } = await this.transport.sendCommand(
        PTPOp.GetObjectHandles,
        [0xFFFFFFFF, 0x0000, 0x00000000],
      )

      if (code !== PTPResp.OK) {
        throw new Error(`GetObjectHandles failed: ${respName(code)}`)
      }

      // Parse handle array: uint32 count, then uint32[] handles
      if (data.length >= 8) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
        const numHandles = view.getUint32(0, true)

        if (numHandles > 0) {
          const handle = view.getUint32(4, true)
          this.log(`Conversion complete (handle=0x${handle.toString(16).padStart(8, '0')})`)

          // Download the JPEG
          this.log('Downloading JPEG...')
          const getResult = await this.transport.sendCommand(
            PTPOp.GetObject,
            [handle],
            60_000, // Large JPEGs may take a moment
          )

          if (getResult.code !== PTPResp.OK) {
            throw new Error(`GetObject failed: ${respName(getResult.code)}`)
          }

          const jpeg = getResult.data
          const sizeMB = (jpeg.length / 1024 / 1024).toFixed(1)
          this.log(`Downloaded ${sizeMB} MB`)

          // Clean up temp object
          try {
            await this.transport.sendCommand(PTPOp.DeleteObject, [handle])
          } catch {
            // Non-fatal
          }

          return jpeg
        }
      }

      // Poll every second
      await new Promise(r => setTimeout(r, 1000))
    }

    throw new Error(`Conversion timeout after ${timeoutMs / 1000}s`)
  }

  /**
   * Upload a RAF and cache the base profile. Call this once per file.
   * After this, use reconvert() for fast re-renders with different settings.
   */
  async loadRaf(data: ArrayBuffer): Promise<Uint8Array> {
    return this.enqueue('default', async () => {
      await this.sendRaf(data)
      this.baseProfile = await this.getProfile()
      this.rafLoaded = true

      await this.setProfile(this.baseProfile as Uint8Array<ArrayBuffer>)
      await this.triggerConversion()
      return this.waitForResult()
    })
  }

  /**
   * Re-convert the already-loaded RAF with new settings.
   * Enqueued as 'render' — latest-wins: pending renders are cancelled
   * when a new one arrives, so only the most recent settings get processed.
   */
  async reconvert(
    buildProfile: (base: Uint8Array) => Uint8Array<ArrayBuffer>,
  ): Promise<Uint8Array> {
    return this.enqueue('render', async () => {
      if (!this.rafLoaded || !this.baseProfile) {
        throw new Error('No RAF loaded — call loadRaf() first')
      }

      const modified = buildProfile(this.baseProfile)
      await this.setProfile(modified)
      await this.triggerConversion()
      return this.waitForResult()
    })
  }
}
