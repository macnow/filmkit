import { FujiCamera, CancelledError, type RawProp } from './ptp/session.ts'
import { USBTransport } from './ptp/transport.ts'
import { formatPresetValue, FujiPropNames } from './ptp/constants.ts'
import {
  FilmSimLabels,
  MONOCHROME_SIMS,
  WBMode, WBModeLabels,
  DynRangeLabels,
  GrainStrengthLabels,
  GrainSizeLabels,
  ColorChromeLabels,
  ColorChromeFxBlueLabels,
  SmoothSkinLabels,
  DRangePriorityLabels,
} from './profile/enums.ts'
import { patchProfile, type ConversionParams } from './profile/d185.ts'
import { cameraProfileToUIValues, translateUIToPresetProps, PRESET_DEFAULTS, type PresetUIValues } from './profile/preset-translate.ts'
import { parseTextPreset, FIELD_LABELS } from './parse-text-preset.ts'
import { encodePresetUrl, decodePresetUrl } from './preset-url.ts'
import {
  type PresetStore, type WorkingPreset,
  createStoreFromScan, createEmptyStore,
  getUnslottedIds, isAnythingDirty, getDirtySlots, valuesChanged,
  swapSlots, copyToLocal, copyToSlot,
  addLocalPreset, removePreset, saveLocalPresets,
  setRafPreset, hasLocalDuplicate, getLocalNames,
} from './preset-store.ts'

// ==========================================================================
// DOM
// ==========================================================================

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

// Left sidebar
const statusEl = $('status')
const cameraNameEl = $('camera-name')
const btnConnect = $<HTMLButtonElement>('btn-connect')
const btnDisconnect = $<HTMLButtonElement>('btn-disconnect')
const browserWarning = $('browser-warning')
const btnSelectRaf = $<HTMLButtonElement>('btn-select-raf')
const recentFilesEl = $('recent-files')
const autoRenderCheckbox = $<HTMLInputElement>('auto-render')
const btnRender = $<HTMLButtonElement>('btn-render')
const presetListEl = $('preset-list')
const savePresetWrap = $('save-preset-wrap')
const btnSavePresets = $<HTMLButtonElement>('btn-save-preset')

// Right sidebar — preset bar
const presetBarName = $<HTMLInputElement>('preset-bar-name')
const presetDirtyEl = $('preset-dirty')
const btnRevertPreset = $<HTMLButtonElement>('btn-revert-preset')

// Canvas
const resultPanel = $('result-panel')
const resultImg = $<HTMLImageElement>('result-img')
const resultInfo = $('result-info')
const resultDownload = $<HTMLAnchorElement>('result-download')
const previewStatus = $('preview-status')
const canvasEmpty = $('canvas-empty')
const canvasEmptyText = $('canvas-empty-text')
const compareToggle = $('compare-toggle')
const compareOriginal = $('compare-original')
const compareConverted = $('compare-converted')

// Needs-render indicator
const needsRenderText = $('needs-render-text')

// Debug
const logEl = $('log')
const btnCopyLog = $<HTMLButtonElement>('btn-copy-log')
const btnClearLog = $<HTMLButtonElement>('btn-clear-log')
const btnScanProps = $<HTMLButtonElement>('btn-scan-props')

// Loading overlay
const loadingOverlay = $('loading-overlay')
const loadingText = $('loading-text')

// Dialog overlay
const dialogOverlay = $('dialog-overlay')
const dialogTitle = $('dialog-title')
const dialogMessage = $('dialog-message')
const dialogActions = $('dialog-actions')

// Paste import overlay
const pasteOverlay = $('paste-overlay')
const pasteNameInput = $<HTMLInputElement>('paste-name')
const pasteTextarea = $<HTMLTextAreaElement>('paste-text')
const pasteCancelBtn = $<HTMLButtonElement>('paste-cancel')
const pasteImportBtn = $<HTMLButtonElement>('paste-import')

// Selects
const filmSimSelect   = $<HTMLSelectElement>('film-sim')
const wbModeSelect    = $<HTMLSelectElement>('wb-mode')
const dynRangeSelect  = $<HTMLSelectElement>('dynamic-range')
const dRangePriSelect = $<HTMLSelectElement>('d-range-priority')
const grainStrengthSelect = $<HTMLSelectElement>('grain-strength')
const grainSizeSelect    = $<HTMLSelectElement>('grain-size')
const grainSizeGroup     = $('grain-size-group')
const colorChromeSelect = $<HTMLSelectElement>('color-chrome')
const ccFxBlueSelect  = $<HTMLSelectElement>('color-chrome-fx-blue')
const smoothSkinSelect = $<HTMLSelectElement>('smooth-skin')

const wbColorTempGroup = $('wb-color-temp-group')

const colorGroup = $('color-group')
const monoWCGroup = $('mono-wc-group')
const monoMGGroup = $('mono-mg-group')

const sliders = {
  highlights:      { input: $<HTMLInputElement>('highlights'),       display: $('highlights-val') },
  shadows:         { input: $<HTMLInputElement>('shadows'),          display: $('shadows-val') },
  color:           { input: $<HTMLInputElement>('color'),            display: $('color-val') },
  monoWC:          { input: $<HTMLInputElement>('mono-wc'),          display: $('mono-wc-val') },
  monoMG:          { input: $<HTMLInputElement>('mono-mg'),          display: $('mono-mg-val') },
  sharpness:       { input: $<HTMLInputElement>('sharpness'),        display: $('sharpness-val') },
  noiseReduction:  { input: $<HTMLInputElement>('noise-reduction'),  display: $('noise-reduction-val') },
  clarity:         { input: $<HTMLInputElement>('clarity'),          display: $('clarity-val') },
  exposure:        { input: $<HTMLInputElement>('exposure'),         display: $('exposure-val') },
  wbColorTemp:     { input: $<HTMLInputElement>('wb-color-temp'),    display: $('wb-color-temp-val') },
  wbShiftR:        { input: $<HTMLInputElement>('wb-shift-r'),       display: $('wb-shift-r-val') },
  wbShiftB:        { input: $<HTMLInputElement>('wb-shift-b'),       display: $('wb-shift-b-val') },
}

// ==========================================================================
// State
// ==========================================================================

let camera: FujiCamera | null = null
let rafData: ArrayBuffer | null = null
let rafFileName = ''
let resultBlobUrl: string | null = null
let originalBlobUrl: string | null = null
let showingOriginal = false
let lastRenderedSettings: ConversionParams | null = null

// Recent files — FileSystemFileHandles persisted in IndexedDB, thumbnails in localStorage
interface RecentFile {
  name: string
  handle: FileSystemFileHandle | null  // null if handle couldn't be restored
  data: ArrayBuffer | null             // cached in memory for current session
  thumbDataUrl: string
}
const MAX_RECENT = 5
const RECENT_KEY = 'filmkit:recent-files'
const IDB_NAME = 'filmkit'
const IDB_STORE = 'file-handles'
let recentFiles: RecentFile[] = []

// Preset state — keyed by preset ID, not name
let store: PresetStore = createEmptyStore()
let activeId: string | null = null
let workingCopies: Map<string, WorkingPreset> = new Map()

// Drag state — stores the preset ID being dragged
let draggedId: string | null = null

// Debounced localStorage save for local presets
let saveLocalTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSaveLocal() {
  if (saveLocalTimer) clearTimeout(saveLocalTimer)
  saveLocalTimer = setTimeout(() => saveLocalPresets(store, workingCopies), 500)
}
function flushSaveLocal() {
  if (saveLocalTimer) { clearTimeout(saveLocalTimer); saveLocalTimer = null }
  saveLocalPresets(store, workingCopies)
}

// ==========================================================================
// Loading overlay
// ==========================================================================

function showLoading(msg: string) {
  loadingText.textContent = msg
  loadingOverlay.classList.add('visible')
}

function hideLoading() {
  loadingOverlay.classList.remove('visible')
}

// ==========================================================================
// Dialog
// ==========================================================================

interface DialogButton {
  label: string
  primary?: boolean
}

/**
 * Show a reusable modal dialog. Returns the index of the button clicked.
 * Example: await showDialog('Error', 'File not found.', [{ label: 'OK', primary: true }])
 */
function showDialog(title: string, message: string, buttons: DialogButton[], html = false): Promise<number> {
  dialogTitle.textContent = title
  if (html) {
    dialogMessage.innerHTML = message
  } else {
    dialogMessage.textContent = message
  }
  dialogActions.innerHTML = ''

  return new Promise<number>((resolve) => {
    buttons.forEach((btn, i) => {
      const el = document.createElement('button')
      el.textContent = btn.label
      if (btn.primary) el.classList.add('primary')
      el.addEventListener('click', () => {
        dialogOverlay.classList.remove('visible')
        resolve(i)
      })
      dialogActions.appendChild(el)
    })
    dialogOverlay.classList.add('visible')
  })
}

// ==========================================================================
// Logging
// ==========================================================================

function log(msg: string) {
  const line = document.createElement('div')
  line.className = 'log-line'
  if (msg.includes('failed') || msg.includes('Error')) line.classList.add('error')
  else if (msg.includes('complete') || msg.includes('opened') || msg.includes('Downloaded')) line.classList.add('success')
  else line.classList.add('info')
  line.textContent = msg
  logEl.appendChild(line)
  logEl.scrollTop = logEl.scrollHeight
  console.log(msg)
}

// ==========================================================================
// UI State
// ==========================================================================

function updateUI() {
  const connected = camera?.connected ?? false
  const rafReady = camera?.rafLoaded ?? false

  statusEl.className = `status-badge ${connected ? 'on' : 'off'}`
  statusEl.textContent = connected ? 'Connected' : 'Disconnected'
  cameraNameEl.textContent = connected ? camera!.modelName : ''

  btnConnect.disabled = connected
  btnDisconnect.disabled = !connected
  btnScanProps.disabled = !connected
  btnSelectRaf.disabled = !connected

  // Show render button when RAF is loaded and auto-render is off
  btnRender.hidden = !rafReady || autoRenderCheckbox.checked

  // Canvas empty state text
  canvasEmptyText.textContent = connected ? 'Load a RAF file to preview' : 'Connect to camera to begin'
}

function showResult(jpeg: Uint8Array) {
  if (resultBlobUrl) URL.revokeObjectURL(resultBlobUrl)
  const blob = new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' })
  resultBlobUrl = URL.createObjectURL(blob)

  resultImg.src = resultBlobUrl
  resultInfo.textContent = `${(jpeg.length / 1024 / 1024).toFixed(1)} MB`
  resultDownload.href = resultBlobUrl
  resultDownload.download = rafFileName.replace(/\.RAF$/i, '') + '_converted.jpg'
  canvasEmpty.hidden = true
  resultPanel.classList.add('visible')

  // Reset toggle to converted view
  showingOriginal = false
  compareOriginal.classList.remove('active')
  compareConverted.classList.add('active')
}

function setCompareView(original: boolean) {
  showingOriginal = original
  compareOriginal.classList.toggle('active', original)
  compareConverted.classList.toggle('active', !original)

  const url = original ? originalBlobUrl : resultBlobUrl
  if (url) {
    resultImg.src = url
    resultDownload.href = url
    const base = rafFileName.replace(/\.RAF$/i, '')
    resultDownload.download = original ? `${base}_original.jpg` : `${base}_converted.jpg`
  }
}

// ==========================================================================
// Thumbnails & Recent files
// ==========================================================================

/** Generate a small thumbnail as a data URL from a JPEG Uint8Array. */
function generateThumbnail(jpeg: Uint8Array): Promise<string> {
  return new Promise((resolve) => {
    const blob = new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      const scale = 64 / Math.max(img.width, img.height)
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL('image/jpeg', 0.7))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve('')
    }
    img.src = url
  })
}

// --- IndexedDB helpers for FileSystemFileHandle persistence ---

const dbPromise: Promise<IDBDatabase> = new Promise((resolve, reject) => {
  const req = indexedDB.open(IDB_NAME, 1)
  req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error)
  req.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'))
})

async function saveHandleToIDB(name: string, handle: FileSystemFileHandle): Promise<void> {
  const db = await dbPromise
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(handle, name)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function getHandleFromIDB(name: string): Promise<FileSystemFileHandle | null> {
  const db = await dbPromise
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly')
    const req = tx.objectStore(IDB_STORE).get(name)
    req.onsuccess = () => resolve(req.result ?? null)
    req.onerror = () => reject(req.error)
  })
}

async function removeHandleFromIDB(name: string): Promise<void> {
  const db = await dbPromise
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).delete(name)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// --- Recent files persistence (thumbnails in localStorage, handles in IndexedDB) ---

/** Load recent files from localStorage + IndexedDB. */
async function loadRecentFromStorage(): Promise<RecentFile[]> {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const items: Array<{ name: string; thumb: string }> = JSON.parse(raw)
    const handles = await Promise.all(
      items.map(i => getHandleFromIDB(i.name).catch(() => null))
    )
    return items.map((i, idx) => ({
      name: i.name, handle: handles[idx], data: null, thumbDataUrl: i.thumb,
    }))
  } catch { return [] }
}

/** Save recent file metadata to localStorage + handle to IndexedDB. */
function saveRecentToStorage() {
  const items = recentFiles.map(f => ({ name: f.name, thumb: f.thumbDataUrl }))
  localStorage.setItem(RECENT_KEY, JSON.stringify(items))
}

/** Add or update an entry in the recent files list. */
async function addToRecent(name: string, handle: FileSystemFileHandle, data: ArrayBuffer, thumbDataUrl: string) {
  recentFiles = recentFiles.filter(f => f.name !== name)
  recentFiles.unshift({ name, handle, data, thumbDataUrl })
  while (recentFiles.length > MAX_RECENT) {
    const removed = recentFiles.pop()!
    removeHandleFromIDB(removed.name).catch(() => {})
  }
  saveRecentToStorage()
  await saveHandleToIDB(name, handle).catch(() => {})
  renderRecentFiles()
}

/** Render the recent files list. */
function renderRecentFiles() {
  recentFilesEl.innerHTML = ''
  for (const f of recentFiles) {
    const item = document.createElement('div')
    item.className = 'recent-file'
    if (f.name === rafFileName) item.classList.add('active')

    if (f.thumbDataUrl) {
      const thumb = document.createElement('img')
      thumb.className = 'recent-thumb'
      thumb.src = f.thumbDataUrl
      thumb.alt = ''
      item.appendChild(thumb)
    }

    const name = document.createElement('span')
    name.className = 'recent-name'
    name.textContent = f.name
    item.appendChild(name)

    const del = document.createElement('button')
    del.className = 'recent-delete'
    del.textContent = '\u00d7'
    del.addEventListener('click', (e) => { e.stopPropagation(); removeRecentEntry(f.name); renderRecentFiles() })
    item.appendChild(del)

    item.addEventListener('click', () => loadRecentFile(f))
    recentFilesEl.appendChild(item)
  }
}

/** Load a file from the recent list using its stored FileSystemFileHandle. */
async function loadRecentFile(f: RecentFile) {
  if (!camera) return
  if (f.name === rafFileName && f.data) return // already loaded

  // If we have cached data, use it directly
  if (f.data) {
    rafData = f.data
    rafFileName = f.name
    currentFileHandle = f.handle
    await doLoadRaf()
    return
  }

  // Try to read from the stored handle
  if (!f.handle) {
    await showDialog('File Unavailable', `"${f.name}" has no stored file handle. Removing from recent files.`, [{ label: 'OK', primary: true }])
    removeRecentEntry(f.name)
    return
  }

  try {
    // Request permission if needed (browser may prompt)
    const perm = await f.handle.queryPermission({ mode: 'read' })
    if (perm !== 'granted') {
      const req = await f.handle.requestPermission({ mode: 'read' })
      if (req !== 'granted') return
    }

    const file = await f.handle.getFile()
    f.data = await file.arrayBuffer()
    rafData = f.data
    rafFileName = f.name
    currentFileHandle = f.handle
    await doLoadRaf()
  } catch {
    await showDialog('File Not Found', `"${f.name}" could not be opened. It may have been moved or deleted.`, [{ label: 'OK', primary: true }])
    removeRecentEntry(f.name)
  }
}

/** Remove a recent file entry by name. */
function removeRecentEntry(name: string) {
  recentFiles = recentFiles.filter(f => f.name !== name)
  saveRecentToStorage()
  removeHandleFromIDB(name).catch(() => {})
  renderRecentFiles()
}

/** Core RAF load flow — upload, get preview, detect preset, generate thumbnail. */
async function doLoadRaf() {
  if (!camera || !rafData) return
  const data = rafData // capture after null guard — rafData is module-level mutable

  showLoading(`Loading ${rafFileName}...`)

  try {
    const jpeg = await camera.loadRaf(data)

    // Cache the original rendering (base profile, no edits) for before/after
    if (originalBlobUrl) URL.revokeObjectURL(originalBlobUrl)
    originalBlobUrl = URL.createObjectURL(new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }))

    showResult(jpeg)

    const thumbUrl = await generateThumbnail(jpeg)
    if (currentFileHandle) {
      await addToRecent(rafFileName, currentFileHandle, data, thumbUrl)
    }

    if (camera.baseProfile) {
      const values = cameraProfileToUIValues(camera.baseProfile)
      const name = rafFileName.replace(/\.RAF$/i, '')
      const { id, matched } = setRafPreset(store, name, values)
      selectPreset(id, false) // don't re-render — patching preserves EXIF sentinels
      if (matched) {
        log(`RAF settings match preset "${displayName(id)}"`)
      } else {
        log('RAF preset created — drag to Local to save')
      }
    }
  } catch (err) {
    if (err instanceof CancelledError) return
    log(`Error: ${err}`)
  } finally {
    hideLoading()
    updateUI()
  }
}

// ==========================================================================
// Populate dropdowns
// ==========================================================================

function populateSelect(select: HTMLSelectElement, labels: Record<number, string>) {
  for (const [value, label] of Object.entries(labels)) {
    const opt = document.createElement('option')
    opt.value = value
    opt.textContent = label
    select.appendChild(opt)
  }
}

populateSelect(filmSimSelect, FilmSimLabels)
populateSelect(wbModeSelect, WBModeLabels)
populateSelect(dynRangeSelect, DynRangeLabels)
populateSelect(dRangePriSelect, DRangePriorityLabels)
populateSelect(grainStrengthSelect, GrainStrengthLabels)
populateSelect(grainSizeSelect, GrainSizeLabels)
populateSelect(colorChromeSelect, ColorChromeLabels)
populateSelect(ccFxBlueSelect, ColorChromeFxBlueLabels)
populateSelect(smoothSkinSelect, SmoothSkinLabels)

// ==========================================================================
// Slider wiring
// ==========================================================================

for (const [key, s] of Object.entries(sliders)) {
  s.input.addEventListener('input', () => {
    const val = parseFloat(s.input.value)
    if (key === 'wbColorTemp') {
      s.display.textContent = val + 'K'
    } else if (key === 'exposure') {
      s.display.textContent = (val >= 0 ? '+' : '') + val.toFixed(1)
    } else {
      s.display.textContent = (val >= 0 ? '+' : '') + val.toString()
    }
  })
}

wbModeSelect.addEventListener('change', () => {
  wbColorTempGroup.hidden = parseInt(wbModeSelect.value) !== WBMode.ColorTemp
})

// Show/hide color vs mono controls based on film sim
function updateMonoControls() {
  const isMono = MONOCHROME_SIMS.has(parseInt(filmSimSelect.value) || 0)
  colorGroup.hidden = isMono
  monoWCGroup.hidden = !isMono
  monoMGGroup.hidden = !isMono
}

filmSimSelect.addEventListener('change', updateMonoControls)

// Show/hide grain size based on strength
grainStrengthSelect.addEventListener('change', () => {
  grainSizeGroup.hidden = parseInt(grainStrengthSelect.value) === 0
})

/** Compose combined GrainEffect value from the two selects. */
function getGrainEffectValue(): number {
  const strength = parseInt(grainStrengthSelect.value) || 0
  if (strength === 0) return 0 // Off
  const size = parseInt(grainSizeSelect.value) || 0
  return (size << 8) | strength
}

/** Decompose combined GrainEffect value into strength + size and set the selects. */
function setGrainEffectUI(combined: number) {
  const strength = combined & 0xFF
  const size = (combined >> 8) & 0xFF
  grainStrengthSelect.value = String(strength)
  grainSizeSelect.value = String(size)
  grainSizeGroup.hidden = strength === 0
}

// ==========================================================================
// Read current settings from UI
// ==========================================================================

function getSettings(): ConversionParams {
  const params: ConversionParams = {
    highlightTone:  parseFloat(sliders.highlights.input.value),
    shadowTone:     parseFloat(sliders.shadows.input.value),
    color:          parseInt(sliders.color.input.value),
    sharpness:      parseInt(sliders.sharpness.input.value),
    noiseReduction: parseInt(sliders.noiseReduction.input.value),
    clarity:        parseInt(sliders.clarity.input.value),
    exposureBias:   Math.round(parseFloat(sliders.exposure.input.value) * 1000),
    wbShiftR:       parseInt(sliders.wbShiftR.input.value),
    wbShiftB:       parseInt(sliders.wbShiftB.input.value),
  }

  const filmSim = filmSimSelect.value
  if (filmSim) params.filmSimulation = parseInt(filmSim)

  const wb = wbModeSelect.value
  if (wb) {
    params.whiteBalance = parseInt(wb)
    if (parseInt(wb) === WBMode.ColorTemp) {
      params.wbColorTemp = parseInt(sliders.wbColorTemp.input.value)
    }
  }

  const dr = dynRangeSelect.value
  if (dr) params.dynamicRange = parseInt(dr)

  const drp = dRangePriSelect.value
  if (drp) params.wideDRange = parseInt(drp)

  const grain = getGrainEffectValue()
  if (grain !== undefined) params.grainEffect = grain

  const skin = smoothSkinSelect.value
  if (skin) params.smoothSkinEffect = parseInt(skin)

  const cc = colorChromeSelect.value
  if (cc) params.colorChromeEffect = parseInt(cc)

  const ccBlue = ccFxBlueSelect.value
  if (ccBlue) params.colorChromeFxBlue = parseInt(ccBlue)

  return params
}

// ==========================================================================
// Preset system — UI helpers
// ==========================================================================

function getCurrentUIValues(): PresetUIValues {
  return {
    filmSimulation: filmSimSelect.value ? parseInt(filmSimSelect.value) : 0,
    dynamicRange: dynRangeSelect.value ? parseInt(dynRangeSelect.value) : 0,
    grainEffect: getGrainEffectValue(),
    smoothSkin: smoothSkinSelect.value ? parseInt(smoothSkinSelect.value) : 0,
    colorChrome: colorChromeSelect.value ? parseInt(colorChromeSelect.value) : 0,
    colorChromeFxBlue: ccFxBlueSelect.value ? parseInt(ccFxBlueSelect.value) : 0,
    whiteBalance: wbModeSelect.value ? parseInt(wbModeSelect.value) : 0,
    wbShiftR: parseInt(sliders.wbShiftR.input.value),
    wbShiftB: parseInt(sliders.wbShiftB.input.value),
    wbColorTemp: parseInt(sliders.wbColorTemp.input.value),
    highlightTone: parseFloat(sliders.highlights.input.value),
    shadowTone: parseFloat(sliders.shadows.input.value),
    color: parseInt(sliders.color.input.value),
    sharpness: parseInt(sliders.sharpness.input.value),
    noiseReduction: parseInt(sliders.noiseReduction.input.value),
    clarity: parseInt(sliders.clarity.input.value),
    exposure: parseFloat(sliders.exposure.input.value),
    dRangePriority: dRangePriSelect.value ? parseInt(dRangePriSelect.value) : 0,
    monoWC: parseInt(sliders.monoWC.input.value),
    monoMG: parseInt(sliders.monoMG.input.value),
  }
}

function applyToUI(name: string, vals: Readonly<PresetUIValues>) {
  filmSimSelect.value = vals.filmSimulation ? String(vals.filmSimulation) : ''
  updateMonoControls()
  wbModeSelect.value = String(vals.whiteBalance)
  dynRangeSelect.value = vals.dynamicRange ? String(vals.dynamicRange) : ''
  dRangePriSelect.value = String(vals.dRangePriority)
  setGrainEffectUI(vals.grainEffect)
  colorChromeSelect.value = String(vals.colorChrome)
  ccFxBlueSelect.value = String(vals.colorChromeFxBlue)
  smoothSkinSelect.value = String(vals.smoothSkin)
  wbColorTempGroup.hidden = vals.whiteBalance !== WBMode.ColorTemp

  setSlider('highlights', vals.highlightTone)
  setSlider('shadows', vals.shadowTone)
  setSlider('color', vals.color)
  setSlider('monoWC', vals.monoWC)
  setSlider('monoMG', vals.monoMG)
  setSlider('sharpness', vals.sharpness)
  setSlider('noiseReduction', vals.noiseReduction)
  setSlider('clarity', vals.clarity)
  setSlider('exposure', vals.exposure)
  setSlider('wbColorTemp', vals.wbColorTemp)
  setSlider('wbShiftR', vals.wbShiftR)
  setSlider('wbShiftB', vals.wbShiftB)

  presetBarName.value = name
}

function setSlider(key: string, value: number) {
  const s = sliders[key as keyof typeof sliders]
  if (!s) return
  s.input.value = String(value)
  s.input.dispatchEvent(new Event('input'))
}

// ==========================================================================
// Preset system — core logic
// ==========================================================================

/** Get the display name for a preset (working copy name if dirty, else stored). */
function displayName(id: string): string {
  const wc = workingCopies.get(id)
  if (wc) return wc.name
  return store.presets.get(id)?.name ?? id
}

/** Is this preset dirty (has unsaved changes)? Local presets auto-save, so never shown as dirty. */
function isPresetDirty(id: string): boolean {
  if (!workingCopies.has(id)) return false
  const preset = store.presets.get(id)
  // Local presets auto-save to localStorage — not "dirty" from user's perspective
  if (preset?.origin === 'local') return false
  return true
}

/** Select a preset by ID. Set preview=false to skip re-render (e.g. after RAF load). */
function selectPreset(id: string, preview = true) {
  const working = workingCopies.get(id)
  const stored = store.presets.get(id)
  if (!working && !stored) return

  const source = working ?? stored!
  applyToUI(source.name, source.values)
  activeId = id
  renderPresetList()
  updatePresetBar()
  if (preview) schedulePreview()
}

/** Check if the active preset has been modified, create/remove working copy. */
function checkDirty() {
  if (!activeId) return

  const snap = store.cameraSnapshots.get(activeId)
  const stored = store.presets.get(activeId)
  if (!snap && !stored) return

  const currentValues = getCurrentUIValues()
  const currentName = presetBarName.value

  const refValues = snap?.values ?? stored!.values
  const refName = snap?.name ?? stored!.name

  const wasDirty = workingCopies.has(activeId)

  if (currentName !== refName || valuesChanged(currentValues, refValues)) {
    workingCopies.set(activeId, { name: currentName, values: currentValues })
  } else {
    workingCopies.delete(activeId)
  }

  // Auto-save local preset edits (debounced to avoid localStorage thrash on keystrokes)
  const preset = store.presets.get(activeId)
  if (preset?.origin === 'local') {
    scheduleSaveLocal()
  }

  // Only full re-render if dirty state toggled (avoids DOM rebuild on every control change)
  if (wasDirty !== workingCopies.has(activeId)) {
    renderPresetList()
  }
  updatePresetBar()
}

function makePresetActions(): HTMLElement {
  const wrap = document.createElement('div')

  const addBtn = document.createElement('button')
  addBtn.className = 'preset-add-btn'
  addBtn.textContent = '+ New Preset'
  addBtn.addEventListener('click', addNewPreset)
  wrap.appendChild(addBtn)

  const ioRow = document.createElement('div')
  ioRow.className = 'preset-io-row'

  // Import button with dropdown (From File / From Text)
  const importAnchor = document.createElement('div')
  importAnchor.className = 'import-dropdown-anchor'

  const importBtn = document.createElement('button')
  importBtn.textContent = 'Import'
  importBtn.style.width = '100%'
  importBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    // Toggle dropdown
    const existing = importAnchor.querySelector('.import-dropdown')
    if (existing) { existing.remove(); return }

    const dropdown = document.createElement('div')
    dropdown.className = 'import-dropdown'

    const fileBtn = document.createElement('button')
    fileBtn.textContent = 'From File'
    fileBtn.addEventListener('click', (ev) => { ev.stopPropagation(); dropdown.remove(); importFromFile() })
    dropdown.appendChild(fileBtn)

    const pasteBtn = document.createElement('button')
    pasteBtn.textContent = 'From Text'
    pasteBtn.addEventListener('click', (ev) => { ev.stopPropagation(); dropdown.remove(); showPasteOverlay() })
    dropdown.appendChild(pasteBtn)

    importAnchor.appendChild(dropdown)

    // Dismiss on outside click
    const dismiss = (ev: MouseEvent) => {
      if (!importAnchor.contains(ev.target as Node)) {
        dropdown.remove()
        document.removeEventListener('click', dismiss)
      }
    }
    setTimeout(() => document.addEventListener('click', dismiss), 0)
  })
  importAnchor.appendChild(importBtn)
  ioRow.appendChild(importAnchor)

  // Export button with dropdown (Download File / Copy Link)
  const exportAnchor = document.createElement('div')
  exportAnchor.className = 'import-dropdown-anchor'

  const exportBtn = document.createElement('button')
  exportBtn.textContent = 'Export'
  exportBtn.style.width = '100%'
  exportBtn.disabled = !activeId
  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    const existing = exportAnchor.querySelector('.import-dropdown')
    if (existing) { existing.remove(); return }

    const dropdown = document.createElement('div')
    dropdown.className = 'import-dropdown'

    const fileBtn = document.createElement('button')
    fileBtn.textContent = 'Download File'
    fileBtn.addEventListener('click', (ev) => { ev.stopPropagation(); dropdown.remove(); exportPreset() })
    dropdown.appendChild(fileBtn)

    const linkBtn = document.createElement('button')
    linkBtn.textContent = 'Copy Link'
    linkBtn.addEventListener('click', (ev) => { ev.stopPropagation(); dropdown.remove(); copyShareLink() })
    dropdown.appendChild(linkBtn)

    exportAnchor.appendChild(dropdown)

    const dismiss = (ev: MouseEvent) => {
      if (!exportAnchor.contains(ev.target as Node)) {
        dropdown.remove()
        document.removeEventListener('click', dismiss)
      }
    }
    setTimeout(() => document.addEventListener('click', dismiss), 0)
  })
  exportAnchor.appendChild(exportBtn)
  ioRow.appendChild(exportAnchor)

  wrap.appendChild(ioRow)
  return wrap
}

// ==========================================================================
// Preset list rendering
// ==========================================================================

function renderPresetList() {
  presetListEl.innerHTML = ''

  // Section 0: "From File" — RAF preset (if loaded)
  const rafId = store.rafPresetId
  if (rafId) {
    const header = document.createElement('div')
    header.className = 'preset-divider preset-divider-first'
    header.textContent = 'From File'
    presetListEl.appendChild(header)

    const item = document.createElement('div')
    item.className = 'preset-item preset-raf'
    if (rafId === activeId) item.classList.add('active')
    item.draggable = true
    item.dataset.presetId = rafId

    const slot = document.createElement('span')
    slot.className = 'preset-slot preset-slot-raf'
    slot.textContent = 'RAF'

    const name = document.createElement('span')
    name.className = 'preset-name'
    const dn = displayName(rafId)
    name.textContent = isPresetDirty(rafId) ? dn + ' *' : dn

    item.appendChild(slot)
    item.appendChild(name)
    item.addEventListener('click', () => selectPreset(rafId))

    // RAF preset is draggable to local/camera (copy semantics handled by drop targets)
    wireRafDrag(item)
    presetListEl.appendChild(item)
  }

  // Section 1: Camera slots
  if (store.slotCount > 0) {
    const header = document.createElement('div')
    header.className = rafId ? 'preset-divider' : 'preset-divider preset-divider-first'
    header.textContent = 'On Camera'
    presetListEl.appendChild(header)
  }

  for (let i = 0; i < store.slotCount; i++) {
    const pid = store.slotMap[i]
    const item = document.createElement('div')
    item.className = 'preset-item'
    if (pid === activeId) item.classList.add('active')
    item.draggable = true
    item.dataset.slotIndex = String(i)
    if (pid) item.dataset.presetId = pid

    const slot = document.createElement('span')
    slot.className = 'preset-slot'
    slot.textContent = `C${i + 1}`

    const name = document.createElement('span')
    name.className = 'preset-name'
    if (pid) {
      const dn = displayName(pid)
      name.textContent = isPresetDirty(pid) ? dn + ' *' : dn
    } else {
      name.textContent = '(empty)'
      name.style.fontStyle = 'italic'
      name.style.opacity = '0.4'
    }

    item.appendChild(slot)
    item.appendChild(name)

    if (pid) {
      item.addEventListener('click', () => selectPreset(pid))
    }

    wireSlotDrag(item, i)
    presetListEl.appendChild(item)
  }

  // "Save Presets in Camera" button — right below camera slots
  if (store.slotCount > 0) {
    presetListEl.appendChild(savePresetWrap)
  }

  // Section 2: Local presets — entire section is a drop target for camera/raf → local copy
  const unslotted = getUnslottedIds(store).filter(id => {
    const p = store.presets.get(id)
    return p && p.origin !== 'raf' // RAF preset shown in its own section
  }).sort((a, b) => displayName(a).localeCompare(displayName(b)))
  if (store.slotCount > 0 || unslotted.length > 0) {
    const localSection = document.createElement('div')
    localSection.className = 'preset-local-section'

    const divider = document.createElement('div')
    divider.className = 'preset-divider'
    divider.textContent = 'Local'
    localSection.appendChild(divider)

    wireLocalSectionDrop(localSection)

    for (const pid of unslotted) {
      const item = document.createElement('div')
      item.className = 'preset-item preset-local'
      if (pid === activeId) item.classList.add('active')
      item.draggable = true
      item.dataset.presetId = pid

      const spacer = document.createElement('span')
      spacer.className = 'preset-slot'
      spacer.textContent = ''

      const name = document.createElement('span')
      name.className = 'preset-name'
      const dn = displayName(pid)
      name.textContent = isPresetDirty(pid) ? dn + ' *' : dn

      const del = document.createElement('button')
      del.className = 'preset-delete'
      del.textContent = '\u00d7'
      del.title = 'Delete preset'
      del.addEventListener('click', (e) => {
        e.stopPropagation()
        deleteLocalPreset(pid)
      })

      item.appendChild(spacer)
      item.appendChild(name)
      item.appendChild(del)
      item.addEventListener('click', () => selectPreset(pid))

      wireUnslottedDrag(item)
      localSection.appendChild(item)
    }

    localSection.appendChild(makePresetActions())
    presetListEl.appendChild(localSection)
  } else {
    presetListEl.appendChild(makePresetActions())
  }
}

/** Create a new local preset from current UI values. */
function addNewPreset() {
  let base = 'New Preset'
  let name = base
  let n = 1
  // Check display names (not IDs) for uniqueness in locals
  const localNames = new Set(
    [...store.presets.values()].filter(p => p.origin === 'local').map(p => p.name)
  )
  while (localNames.has(name)) {
    n++
    name = `${base} ${n}`
  }

  const values = getCurrentUIValues()
  const id = addLocalPreset(store, name, values)
  flushSaveLocal()

  activeId = id
  presetBarName.value = name
  renderPresetList()
  updatePresetBar()

  presetBarName.disabled = false
  presetBarName.select()
}

/** Delete a local preset. */
function deleteLocalPreset(id: string) {
  if (!removePreset(store, id)) return

  workingCopies.delete(id)
  if (activeId === id) activeId = null

  flushSaveLocal()
  renderPresetList()
  updatePresetBar()
}

// ==========================================================================
// Preset file import/export (.filmkit / .json)
// ==========================================================================

/** Build a human-readable label for a grain effect combined value. */
function grainLabel(combined: number): string {
  if (combined === 0) return 'Off'
  const strength = GrainStrengthLabels[combined & 0xFF]
  const size = GrainSizeLabels[(combined >> 8) & 0xFF]
  if (!strength) return `Unknown (${combined})`
  return `${strength} ${size ?? 'Small'}`
}

/** Export the currently active preset to a .filmkit file. */
function exportPreset() {
  if (!activeId) return
  const wc = workingCopies.get(activeId)
  const preset = store.presets.get(activeId)
  const name = presetBarName.value || (wc?.name ?? preset?.name ?? 'Untitled')
  const values = wc?.values ?? preset?.values
  if (!values) return

  const data = {
    filmkit: 1,
    name,
    values: { ...values },
    _labels: {
      filmSimulation: FilmSimLabels[values.filmSimulation] ?? 'Unknown',
      whiteBalance: WBModeLabels[values.whiteBalance] ?? 'Unknown',
      dynamicRange: DynRangeLabels[values.dynamicRange] ?? 'Auto',
      grainEffect: grainLabel(values.grainEffect),
      colorChrome: ColorChromeLabels[values.colorChrome] ?? 'Unknown',
      colorChromeFxBlue: ColorChromeFxBlueLabels[values.colorChromeFxBlue] ?? 'Unknown',
      smoothSkin: SmoothSkinLabels[values.smoothSkin] ?? 'Unknown',
      dRangePriority: DRangePriorityLabels[values.dRangePriority] ?? 'Unknown',
    },
  }

  const json = JSON.stringify(data, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const safeName = name.replace(/[^a-zA-Z0-9_\- ]/g, '').trim() || 'preset'
  a.download = safeName + '.filmkit'
  a.click()
  URL.revokeObjectURL(url)
}

/** Copy a shareable link for the active preset to clipboard. */
function copyShareLink() {
  if (!activeId) return
  const wc = workingCopies.get(activeId)
  const preset = store.presets.get(activeId)
  const name = presetBarName.value || (wc?.name ?? preset?.name ?? 'Untitled')
  const values = wc?.values ?? preset?.values
  if (!values) return

  const encoded = encodePresetUrl(name, values)
  const url = `${location.origin}${location.pathname}#preset=${encoded}`
  navigator.clipboard.writeText(url).then(() => {
    log(`Link copied for "${name}"`)
    showDialog('Link Copied', `Shareable link for "${name}" copied to clipboard.`, [{ label: 'OK', primary: true }])
  }).catch(() => {
    log('Failed to copy link to clipboard')
  })
}

/**
 * Import a parsed JSON object as a local preset.
 * Returns the preset name on success, or an error string on failure.
 */
function importFromJSON(data: unknown, fallbackName: string): { name: string } | { error: string } {
  if (!data || typeof data !== 'object') return { error: 'Invalid data.' }
  const obj = data as Record<string, unknown>
  if (!obj.values || typeof obj.values !== 'object') {
    return { error: 'Invalid file: missing preset values.' }
  }

  const values: PresetUIValues = { ...PRESET_DEFAULTS }
  for (const key of Object.keys(PRESET_DEFAULTS) as (keyof PresetUIValues)[]) {
    const v = (obj.values as Record<string, unknown>)[key]
    if (typeof v === 'number' && isFinite(v)) {
      values[key] = v
    }
  }

  const name = typeof obj.name === 'string' ? obj.name : fallbackName
  const id = addLocalPreset(store, name, values)
  flushSaveLocal()
  selectPreset(id)
  log(`Imported preset: "${name}"`)
  return { name }
}

/** Import a .filmkit or .json file as a new local preset. */
async function importFromFile() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.filmkit,.json'

  input.addEventListener('change', async () => {
    const file = input.files?.[0]
    if (!file) return

    try {
      const text = await file.text()
      const data = JSON.parse(text)
      const result = importFromJSON(data, file.name.replace(/\.(filmkit|json)$/i, ''))
      if ('error' in result) {
        await showDialog('Import Error', result.error, [{ label: 'OK', primary: true }])
      } else {
        await showDialog('Preset Imported', `"${result.name}" has been added to your local presets.`, [{ label: 'OK', primary: true }])
      }
    } catch {
      await showDialog('Import Error', 'Failed to parse file. Expected a .filmkit or .json preset file.', [{ label: 'OK', primary: true }])
    }
  })

  input.click()
}

// ==========================================================================
// Paste import overlay
// ==========================================================================

function showPasteOverlay() {
  pasteNameInput.value = ''
  pasteTextarea.value = ''
  pasteImportBtn.disabled = true
  pasteOverlay.classList.add('visible')
  pasteNameInput.focus()
}

function hidePasteOverlay() {
  pasteOverlay.classList.remove('visible')
}

function updatePasteImportBtn() {
  pasteImportBtn.disabled = !pasteNameInput.value.trim() || !pasteTextarea.value.trim()
}
pasteNameInput.addEventListener('input', updatePasteImportBtn)
pasteTextarea.addEventListener('input', updatePasteImportBtn)

/** Build an HTML summary of the text parse result for the confirmation dialog. */
function buildParseSummary(result: ReturnType<typeof parseTextPreset>): string {
  const lines: string[] = []

  if (result.recognized.length) {
    for (const r of result.recognized) {
      const fieldNames = r.fields.map(f => FIELD_LABELS[f] ?? f).join(', ')
      lines.push(`<span style="color:var(--success)">\u2713</span> ${esc(r.line)} <span style="color:var(--text-muted)">\u2192 ${esc(fieldNames)}</span>`)
    }
  }

  if (result.unrecognized.length) {
    for (const u of result.unrecognized) {
      lines.push(`<span style="color:#c88">\u2717</span> ${esc(u)} <span style="color:var(--text-muted)">(unrecognized)</span>`)
    }
  }

  if (result.ignored.length) {
    for (const ig of result.ignored) {
      lines.push(`<span style="color:var(--text-muted)">\u2014 ${esc(ig)} (ignored)</span>`)
    }
  }

  return `<div style="font-size:var(--font-m);line-height:1.8;max-height:16rem;overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--border) transparent">${lines.join('<br>')}</div>`
}

/** Escape HTML special characters */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function handlePasteImport() {
  const text = pasteTextarea.value.trim()
  const presetName = pasteNameInput.value.trim()
  if (!text || !presetName) return

  // Try JSON first (filmkit format)
  try {
    const data = JSON.parse(text)
    const result = importFromJSON(data, presetName)
    if ('error' in result) {
      await showDialog('Import Error', result.error, [{ label: 'OK', primary: true }])
    } else {
      hidePasteOverlay()
    }
    return
  } catch {
    // Not JSON — fall through to text parsing
  }

  // Text parsing (FXW format)
  const result = parseTextPreset(text)

  if (Object.keys(result.values).length === 0) {
    await showDialog('Import Error', 'No preset fields could be recognized from the text.', [{ label: 'OK', primary: true }])
    return
  }

  // Show summary for confirmation
  const summary = buildParseSummary(result)
  const choice = await showDialog(
    'Import Summary',
    summary,
    [{ label: 'Cancel' }, { label: 'Import', primary: true }],
    true,
  )

  if (choice !== 1) return

  // Merge parsed values with defaults
  const values: PresetUIValues = { ...PRESET_DEFAULTS }
  for (const [k, v] of Object.entries(result.values)) {
    ;(values as unknown as Record<string, number>)[k] = v as number
  }

  const id = addLocalPreset(store, presetName, values)
  flushSaveLocal()
  selectPreset(id)
  hidePasteOverlay()
  log(`Imported preset: "${presetName}"`)
}

pasteCancelBtn.addEventListener('click', hidePasteOverlay)
pasteImportBtn.addEventListener('click', handlePasteImport)

/** Update the preset bar (right sidebar header). */
function updatePresetBar() {
  if (activeId) {
    presetBarName.disabled = false
    const dirty = isPresetDirty(activeId)
    presetDirtyEl.classList.toggle('visible', dirty)
    btnRevertPreset.classList.toggle('visible', dirty)
  } else {
    presetBarName.value = 'No preset selected'
    presetBarName.disabled = true
    presetDirtyEl.classList.remove('visible')
    btnRevertPreset.classList.remove('visible')
  }

  const dirty = isAnythingDirty(store, workingCopies)
  savePresetWrap.hidden = store.slotCount === 0
  btnSavePresets.disabled = !dirty
}

// ==========================================================================
// Drag and drop
// ==========================================================================

/** Create an off-screen drag ghost showing just the preset name. */
function setDragImage(e: DragEvent, id: string) {
  const ghost = document.createElement('div')
  ghost.className = 'drag-ghost'
  ghost.textContent = displayName(id)
  document.body.appendChild(ghost)
  e.dataTransfer!.setDragImage(ghost, 0, 12)
  requestAnimationFrame(() => ghost.remove())
}

/** Wire shared drag source behavior (dragstart/dragend) on an item. */
function wireDragSource(item: HTMLElement, effectAllowed: string) {
  item.addEventListener('dragstart', (e) => {
    const pid = item.dataset.presetId
    if (!pid) { e.preventDefault(); return }
    draggedId = pid
    e.dataTransfer!.effectAllowed = effectAllowed as DataTransfer['effectAllowed']
    e.dataTransfer!.setData('text/plain', pid)
    setDragImage(e, pid)
    item.classList.add('dragging')
  })

  item.addEventListener('dragend', () => {
    draggedId = null
    item.classList.remove('dragging')
    clearDropTargets()
  })
}

function wireSlotDrag(item: HTMLElement, slotIndex: number) {
  wireDragSource(item, 'copyMove')

  // Slot is a drop target
  item.addEventListener('dragover', (e) => {
    e.preventDefault()
    e.dataTransfer!.dropEffect = draggedId && store.slotMap.includes(draggedId) ? 'move' : 'copy'
    item.classList.add('drag-over')
  })

  item.addEventListener('dragleave', () => {
    item.classList.remove('drag-over')
  })

  item.addEventListener('drop', (e) => {
    e.preventDefault()
    item.classList.remove('drag-over')
    const srcId = e.dataTransfer!.getData('text/plain')
    if (!srcId) return

    const sourceSlot = store.slotMap.indexOf(srcId)
    if (sourceSlot >= 0 && sourceSlot !== slotIndex) {
      // Same section (camera → camera): swap
      swapSlots(store, sourceSlot, slotIndex)
    } else if (sourceSlot < 0) {
      // Cross-section (local → camera): copy into the slot
      copyToSlot(store, srcId, slotIndex)
      flushSaveLocal()
    }

    renderPresetList()
    updatePresetBar()
  })
}

function wireUnslottedDrag(item: HTMLElement) {
  wireDragSource(item, 'copyMove')
}

function wireRafDrag(item: HTMLElement) {
  wireDragSource(item, 'copy')
}

function wireLocalSectionDrop(section: HTMLElement) {
  section.addEventListener('dragover', (e) => {
    if (!draggedId) return
    const preset = store.presets.get(draggedId)
    // Accept camera-slot or raf presets for copy to local
    if (preset && (preset.origin === 'camera' || preset.origin === 'raf')) {
      e.preventDefault()
      e.dataTransfer!.dropEffect = 'copy'
      section.classList.add('drag-over')
    }
  })

  section.addEventListener('dragleave', (e) => {
    if (!section.contains(e.relatedTarget as Node)) {
      section.classList.remove('drag-over')
    }
  })

  section.addEventListener('drop', (e) => {
    e.preventDefault()
    section.classList.remove('drag-over')
    const srcId = e.dataTransfer!.getData('text/plain')
    if (!srcId) return

    const preset = store.presets.get(srcId)
    if (preset && (preset.origin === 'camera' || preset.origin === 'raf')) {
      copyToLocal(store, srcId)
      flushSaveLocal()
      renderPresetList()
      updatePresetBar()
    }
  })
}

function clearDropTargets() {
  presetListEl.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'))
}

// ==========================================================================
// Live preview
// ==========================================================================

let debounceTimer: ReturnType<typeof setTimeout> | null = null
const DEBOUNCE_MS = 400
const mobileQuery = window.matchMedia('(max-width: 900px)')
let mobilePreviewDirty = false

/** Check if the displayed image is stale (settings changed since last render). */
function updateNeedsRender() {
  if (!lastRenderedSettings || !resultPanel.classList.contains('visible')) {
    needsRenderText.classList.remove('visible')
    return
  }
  const current = getSettings()
  const stale = JSON.stringify(current) !== JSON.stringify(lastRenderedSettings)
  needsRenderText.classList.toggle('visible', stale)
}

function schedulePreview() {
  if (!camera?.rafLoaded) return
  // Mobile: defer render until user switches to Preview tab
  if (mobileQuery.matches) {
    mobilePreviewDirty = true
    return
  }
  if (!autoRenderCheckbox.checked) { updateNeedsRender(); return } // manual mode — user clicks Render
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(doPreview, DEBOUNCE_MS)
}

async function doPreview(force = false) {
  if (!camera?.rafLoaded) return

  // Skip if settings haven't changed since last render (unless forced)
  if (!force && lastRenderedSettings) {
    const current = getSettings()
    if (JSON.stringify(current) === JSON.stringify(lastRenderedSettings)) {
      needsRenderText.classList.remove('visible')
      return
    }
  }

  needsRenderText.classList.remove('visible')
  previewStatus.textContent = 'Rendering...'
  previewStatus.parentElement!.classList.add('active')

  try {
    const settings = getSettings()
    const jpeg = await camera.reconvert((base) => patchProfile(base, settings))
    showResult(jpeg)
    lastRenderedSettings = settings
    previewStatus.textContent = ''
    previewStatus.parentElement!.classList.remove('active')
  } catch (err) {
    if (err instanceof CancelledError) return // superseded by newer render
    log(`Preview error: ${err}`)
    previewStatus.textContent = 'Error'
    previewStatus.parentElement!.classList.remove('active')
    updateNeedsRender()
  }
}

// Attach to all controls — preview + dirty detection
const allSelects = [filmSimSelect, wbModeSelect, dynRangeSelect, dRangePriSelect, grainStrengthSelect, grainSizeSelect, colorChromeSelect, ccFxBlueSelect, smoothSkinSelect]
for (const sel of allSelects) {
  sel.addEventListener('change', () => { checkDirty(); schedulePreview() })
}
for (const s of Object.values(sliders)) {
  s.input.addEventListener('change', () => { checkDirty(); schedulePreview() })
}
presetBarName.addEventListener('input', () => checkDirty())

// ==========================================================================
// WebUSB check
// ==========================================================================

if (!USBTransport.isSupported()) {
  browserWarning.hidden = false
  btnConnect.disabled = true
}

// ==========================================================================
// Event handlers
// ==========================================================================

btnConnect.addEventListener('click', async () => {
  showLoading('Connecting...')
  log('--- Connecting ---')

  camera = new FujiCamera(log)
  const result = await camera.connect()

  if (!result.ok) {
    camera = null
    hideLoading()
    updateUI()

    // Show platform-aware error dialog for interface-busy errors
    if (result.error === 'interface-busy') {
      const isMac = /Mac/i.test(navigator.platform) || /Mac/i.test(navigator.userAgent)
      const message = isMac
        ? 'Another application is using the camera\'s USB connection.<br><br>'
          + '<b>To fix this on macOS:</b><br>'
          + '1. Quit any camera apps (X RAW Studio, Capture One, Photos)<br>'
          + '2. Unplug and re-plug the camera, then try connecting again<br>'
          + '3. If that doesn\'t work, run in Terminal:<br>'
          + '<code style="font-size:var(--mono-m);color:var(--accent)">killall ptpcamerad</code><br>'
          + 'then try connecting again immediately'
        : 'Failed to claim the USB interface. Another application or driver may be using the camera'
      await showDialog('Connection Failed', message, [{ label: 'OK', primary: true }], true)
    }
    return
  }

  showLoading('Loading presets...')
  try {
    const scanned = await camera.scanPresets()
    if (scanned.length === 0 && camera.supportedProperties.has(0xD18C)) {
      // Camera advertises preset support but returned nothing — wrong USB mode
      hideLoading()
      log('No presets found — camera may be in wrong USB mode')
      await showDialog(
        'Camera Mode Error',
        'Failed to read camera presets. Your camera may be in the wrong USB mode.<br><br>'
        + 'On your camera, go to:<br>'
        + '<b>Network/USB Setting → Connection Mode → USB Raw Conv./Backup Restore</b><br><br>'
        + 'Then disconnect and reconnect.',
        [{ label: 'OK', primary: true }],
        true,
      )
    } else if (scanned.length === 0) {
      // Camera doesn't support preset properties — still allow RAF conversion
      hideLoading()
      log(`${camera.modelName}: preset editing not supported — RAW conversion available`)
      await showDialog(
        'Limited Support',
        `Connected to <b>${camera.modelName}</b>. This camera does not support preset editing via USB, `
        + 'but RAW conversion is available.<br><br>'
        + 'You can load a RAF file and convert it using the controls on the right.',
        [{ label: 'OK', primary: true }],
        true,
      )
    } else {
      store = createStoreFromScan(scanned)
      workingCopies.clear()
      activeId = null
      renderPresetList()
      updatePresetBar()
    }
  } catch (err) {
    log(`Preset scan error: ${err}`)
    hideLoading()
    await showDialog(
      'Camera Mode Error',
      'Failed to read camera properties. Your camera may be in the wrong USB mode.<br><br>'
      + 'On your camera, go to:<br>'
      + '<b>Network/USB Setting → Connection Mode → USB Raw Conv./Backup Restore</b><br><br>'
      + 'Then disconnect and reconnect.',
      [{ label: 'OK', primary: true }],
      true,
    )
  }

  hideLoading()
  startHeartbeat()
  updateUI()
})

// ==========================================================================
// Connection heartbeat — detect camera disconnect
// ==========================================================================

let heartbeatTimer: ReturnType<typeof setInterval> | null = null
const HEARTBEAT_MS = 3000

function startHeartbeat() {
  stopHeartbeat()
  heartbeatTimer = setInterval(async () => {
    if (!camera?.connected) return
    // Use the command queue to avoid concurrent USB I/O
    try {
      await camera.heartbeat()
    } catch {
      log('--- Camera connection lost ---')
      stopHeartbeat()
      resetApp()
    }
  }, HEARTBEAT_MS)
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

/** Reset all state to disconnected. Called on manual disconnect or USB unplug. */
function resetApp() {
  stopHeartbeat()
  camera = null
  rafData = null
  rafFileName = ''
  currentFileHandle = null
  store = createEmptyStore()
  workingCopies.clear()
  activeId = null

  // Clear UI
  if (resultBlobUrl) { URL.revokeObjectURL(resultBlobUrl); resultBlobUrl = null }
  if (originalBlobUrl) { URL.revokeObjectURL(originalBlobUrl); originalBlobUrl = null }
  showingOriginal = false
  resultPanel.classList.remove('visible')
  canvasEmpty.hidden = false
  lastRenderedSettings = null
  needsRenderText.classList.remove('visible')
  previewStatus.textContent = ''
  previewStatus.parentElement!.classList.remove('active')
  hideLoading()

  renderPresetList()
  updatePresetBar()
  renderRecentFiles()
  updateUI()
}

btnDisconnect.addEventListener('click', async () => {
  if (!camera) return
  log('--- Disconnecting ---')
  await camera.disconnect()
  resetApp()
})

// Handle physical USB disconnect (camera unplugged)
navigator.usb?.addEventListener('disconnect', () => {
  if (camera) {
    log('--- Camera disconnected ---')
    camera.disconnect().catch(() => {}).finally(() => resetApp())
  }
})

// Close PTP session on page unload to prevent stale sessions
window.addEventListener('beforeunload', () => {
  camera?.emergencyClose()
})

btnRevertPreset.addEventListener('click', () => {
  if (!activeId) return
  const snap = store.cameraSnapshots.get(activeId)
  const stored = store.presets.get(activeId)
  if (!snap && !stored) return

  workingCopies.delete(activeId)
  const source = snap ?? stored!
  applyToUI(source.name, source.values)
  renderPresetList()
  updatePresetBar()
  schedulePreview()
})

btnSavePresets.addEventListener('click', async () => {
  if (!camera) return

  const dirtySlots = getDirtySlots(store, workingCopies)
  if (dirtySlots.length === 0) return

  // Confirmation dialog
  const slotNames = dirtySlots.map(i => `C${i + 1}`).join(', ')
  const choice = await showDialog(
    'Save to Camera',
    `Write changes to ${slotNames}? This will overwrite the current presets on the camera.`,
    [{ label: 'Cancel' }, { label: 'Save', primary: true }],
  )
  if (choice !== 1) return

  showLoading('Saving presets...')
  stopHeartbeat()
  let allOk = true

  for (const slotIdx of dirtySlots) {
    const presetId = store.slotMap[slotIdx]
    if (!presetId) continue

    const wc = workingCopies.get(presetId)
    const preset = store.presets.get(presetId)
    const name = wc?.name ?? preset?.name ?? `C${slotIdx + 1}`
    const values = wc?.values ?? preset?.values
    if (!values) continue

    const baseRaw = store.rawSettings.get(presetId) ?? undefined
    const rawProps = translateUIToPresetProps(values, baseRaw)

    showLoading(`Saving C${slotIdx + 1}: "${name}"...`)
    log(`Writing C${slotIdx + 1}: "${name}"...`)

    const result = await camera.writePreset(slotIdx + 1, name, rawProps)

    for (const w of result.warnings) log(`  warning: ${w}`)

    if (!result.ok) {
      log(`  FAILED: ${result.warnings[result.warnings.length - 1]}`)
      allOk = false
      hideLoading()
      await showDialog('Save Failed', `C${slotIdx + 1} failed. Remaining slots not written.\n\n${result.warnings.join('\n')}`, [{ label: 'OK', primary: true }])
      break
    }
    log(`  C${slotIdx + 1} OK`)
  }

  if (allOk) {
    // Remember which slot was selected so we can re-select after rescan
    const prevSlotIdx = activeId ? store.slotMap.indexOf(activeId) : -1

    // Re-scan to refresh store from actual camera state
    showLoading('Verifying...')
    log('Re-scanning presets to confirm...')
    try {
      const scanned = await camera.scanPresets()
      store = createStoreFromScan(scanned)
      workingCopies.clear()

      // Re-select the preset at the same slot (IDs change across rescans)
      const newId = prevSlotIdx >= 0 ? store.slotMap[prevSlotIdx] : null
      if (newId && store.presets.has(newId)) {
        selectPreset(newId, false)
      } else {
        activeId = null
        renderPresetList()
        updatePresetBar()
      }

      log('Save complete')
    } catch (err) {
      log(`Re-scan error: ${err}`)
    }
  }

  hideLoading()
  startHeartbeat()
  updateUI()
})

btnScanProps.addEventListener('click', async () => {
  if (!camera) return
  btnScanProps.disabled = true
  btnScanProps.textContent = 'Scanning...'

  try {
    // Dump supported operations (especially vendor 0x9xxx)
    const info = await camera.getDeviceInfo()
    log('--- Supported Operations ---')
    const stdOps: Record<number, string> = {
      0x1001: 'GetDeviceInfo', 0x1002: 'OpenSession', 0x1003: 'CloseSession',
      0x1004: 'GetStorageIDs', 0x1005: 'GetStorageInfo', 0x1006: 'GetNumObjects',
      0x1007: 'GetObjectHandles', 0x1008: 'GetObjectInfo', 0x1009: 'GetObject',
      0x100B: 'DeleteObject', 0x100C: 'SendObjectInfo', 0x100D: 'SendObject',
      0x1014: 'GetDevicePropDesc', 0x1015: 'GetDevicePropValue',
      0x1016: 'SetDevicePropValue', 0x1017: 'ResetDevicePropValue',
      0x900C: 'Fuji:SendObjectInfo', 0x900D: 'Fuji:SendObject2',
    }
    for (const op of info.operations) {
      const hex = '0x' + op.toString(16).toUpperCase().padStart(4, '0')
      const name = stdOps[op]
      if (name) {
        log(`  ${hex} ${name}`)
      } else if (op >= 0x9000) {
        log(`  ${hex} ** VENDOR OPERATION (unknown) **`)
      } else {
        log(`  ${hex} (standard, unnamed)`)
      }
    }
    log(`--- ${info.operations.length} operations ---`)

    log('--- Supported Properties (DeviceInfo) ---')
    for (const pid of info.properties) {
      const hex = '0x' + pid.toString(16).toUpperCase().padStart(4, '0')
      const name = FujiPropNames[pid]
      log(`  ${hex}${name ? ' ' + name : ''}`)
    }
    log(`--- ${info.properties.length} properties ---`)

    const props = await camera.scanProperties()
    log('--- Camera Properties ---')
    for (const p of props) logProp(p, false)
    log(`--- ${props.length} properties ---`)

  } catch (err) {
    log(`Scan error: ${err}`)
  } finally {
    btnScanProps.textContent = 'Dump Props'
    btnScanProps.disabled = false
  }
})

function logProp(p: RawProp, decode = false) {
  const id = '0x' + p.id.toString(16).toUpperCase().padStart(4, '0')
  const hex = Array.from(p.bytes.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' ')
  const decoded = decode ? formatPresetValue(p.id, p.value) : null
  if (typeof p.value === 'string') {
    log(`  ${id} ${p.name.padEnd(24)} = "${p.value}"`)
  } else {
    const v = p.value
    const hexVal = v >= 0 ? `0x${v.toString(16).toUpperCase()}` : `-0x${(-v).toString(16).toUpperCase()}`
    const suffix = decoded ? `  → ${decoded}` : ''
    log(`  ${id} ${p.name.padEnd(24)} = ${String(v).padStart(6)} ${hexVal.padStart(8)}  [${hex}]${suffix}`)
  }
}

btnCopyLog.addEventListener('click', () => {
  const text = logEl.innerText
  navigator.clipboard.writeText(text).then(() => {
    btnCopyLog.textContent = 'Copied!'
    setTimeout(() => { btnCopyLog.textContent = 'Copy Log' }, 1500)
  })
})

btnClearLog.addEventListener('click', () => {
  logEl.innerHTML = ''
})

// Before/after compare toggle
compareToggle.addEventListener('click', () => setCompareView(!showingOriginal))

// Current file handle — needed for addToRecent
let currentFileHandle: FileSystemFileHandle | null = null

btnSelectRaf.addEventListener('click', async () => {
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{
        description: 'Fuji RAW files',
        accept: { 'image/x-fuji-raf': ['.raf', '.RAF'] },
      }],
    })

    const file = await handle.getFile()
    rafFileName = file.name
    currentFileHandle = handle
    log(`Selected: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`)

    const data = await file.arrayBuffer()
    rafData = data

    const header = new TextDecoder().decode(new Uint8Array(data, 0, 15))
    if (!header.startsWith('FUJIFILMCCD-RAW')) {
      log('Warning: file may not be a valid RAF')
      return
    }

    await doLoadRaf()
  } catch (err) {
    // User cancelled the picker — not an error
    if (err instanceof DOMException && err.name === 'AbortError') return
    log(`File open error: ${err}`)
  }
})

// Render button — manual trigger when auto-render is off
btnRender.addEventListener('click', () => doPreview(true))

// Auto-render toggle — show/hide render bar
autoRenderCheckbox.addEventListener('change', () => {
  updateUI()
  // If just enabled and RAF is loaded, trigger a render
  if (autoRenderCheckbox.checked && camera?.rafLoaded) {
    schedulePreview()
  }
})

// ==========================================================================
// Init
// ==========================================================================

declare const __APP_VERSION__: string
$('brand-version').textContent = `v${__APP_VERSION__}`

updateUI()
renderPresetList()
updatePresetBar()

// Load recent files from IndexedDB (async) then render
loadRecentFromStorage().then(files => {
  recentFiles = files
  renderRecentFiles()
})

// Import preset from URL hash (#preset=...)
function importFromUrlHash() {
  const hash = location.hash
  if (!hash.startsWith('#preset=')) return

  const encoded = hash.slice('#preset='.length)
  const decoded = decodePresetUrl(encoded)
  if (!decoded) {
    log('Invalid preset link')
    return
  }

  // Clean URL
  history.replaceState(null, '', location.pathname + location.search)

  const { values } = decoded
  let { name } = decoded

  // Dedup: same name + same values → skip, select existing
  if (hasLocalDuplicate(store, name, values)) {
    for (const p of store.presets.values()) {
      if (p.origin === 'local' && p.name === name && !valuesChanged(p.values, values)) {
        selectPreset(p.id)
        break
      }
    }
    showDialog('Already Exists', `"${name}" is already in your local presets.`, [{ label: 'OK', primary: true }])
    return
  }

  // Same name but different values → append (1), (2), etc.
  const localNames = getLocalNames(store)
  if (localNames.has(name)) {
    let n = 1
    while (localNames.has(`${name} (${n})`)) n++
    name = `${name} (${n})`
  }

  const id = addLocalPreset(store, name, values)
  flushSaveLocal()
  renderPresetList()
  selectPreset(id)
  log(`Imported preset from link: "${name}"`)
  showDialog('Preset Imported', `"${name}" has been added to your local presets.`, [{ label: 'OK', primary: true }])
}
importFromUrlHash()

log('FilmKit ready. Connect your camera to begin.')

// Beta disclaimer — shown once per browser
const BETA_KEY = 'filmkit:beta-dismissed'
if (!localStorage.getItem(BETA_KEY)) {
  showDialog(
    'Beta',
    'FilmKit is in beta and has only been tested on <b>X100VI</b>. '
    + 'It should work with other Fujifilm X-Trans cameras, but this has not been verified.<br><br>'
    + 'If you have a different camera, please help us expand support: '
    + '<a href="https://github.com/eggricesoy/filmkit#supporting-new-cameras" target="_blank" rel="noopener" style="color:var(--accent)">Supporting New Cameras</a>',
    [{ label: 'Got it', primary: true }],
    true,
  ).then(() => localStorage.setItem(BETA_KEY, '1'))
}

// ==========================================================================
// Mobile tab switching
// ==========================================================================

const mobileTabs = document.getElementById('mobile-tabs')
const appEl = document.querySelector('.app') as HTMLElement

mobileTabs?.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-panel]')
  if (!btn) return
  const panel = btn.dataset.panel!
  appEl.dataset.panel = panel
  mobileTabs.querySelectorAll('.mobile-tab').forEach(t => t.classList.remove('active'))
  btn.classList.add('active')

  // Auto-render when switching to Preview with pending changes
  if (panel === 'preview' && mobilePreviewDirty) {
    mobilePreviewDirty = false
    doPreview()
  }
})
