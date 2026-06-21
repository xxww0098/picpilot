import type { AgentConversation, CanvasDocument, TaskRecord, StoredImage, StoredImageThumbnail, StoredVideo } from '../../types'
import { loadImage } from '../imaging/canvasImage'
import { logger, serializeError } from './logger'
import { namespacedStorageKey } from './auth'

const DB_NAME = namespacedStorageKey('picpilot')
const DB_VERSION = 5
const STORE_TASKS = 'tasks'
const STORE_IMAGES = 'images'
const STORE_THUMBNAILS = 'thumbnails'
const STORE_VIDEOS = 'videos'
const STORE_AGENT_CONVERSATIONS = 'agentConversations'
const STORE_CANVASES = 'canvases'
const THUMBNAIL_MAX_SIZE = 720
const THUMBNAIL_QUALITY = 0.9
const THUMBNAIL_VERSION = 2

export const CURRENT_THUMBNAIL_VERSION = THUMBNAIL_VERSION

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = openDBConnection()
    // 打开失败时清空缓存，避免缓存一个 rejected 的 promise 导致后续调用永久失败
    dbPromise.catch((error) => {
      logger.error('db', 'IndexedDB 打开失败', { dbName: DB_NAME, dbVersion: DB_VERSION, error: serializeError(error) })
      dbPromise = null
    })
  }
  return dbPromise
}

function openDBConnection(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE_TASKS)) {
        db.createObjectStore(STORE_TASKS, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_IMAGES)) {
        db.createObjectStore(STORE_IMAGES, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_THUMBNAILS)) {
        db.createObjectStore(STORE_THUMBNAILS, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_VIDEOS)) {
        db.createObjectStore(STORE_VIDEOS, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_AGENT_CONVERSATIONS)) {
        db.createObjectStore(STORE_AGENT_CONVERSATIONS, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_CANVASES)) {
        db.createObjectStore(STORE_CANVASES, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => {
      const db = req.result
      // 连接意外关闭或被其他标签页的版本升级中断时，丢弃缓存以便下次重新打开
      db.onclose = () => {
        if (dbPromise) dbPromise = null
      }
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      resolve(db)
    }
    req.onerror = () => reject(req.error)
  })
}

function dbTransaction<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode)
        const store = tx.objectStore(storeName)
        const req = fn(store)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

// ===== Tasks =====

export function getAllTasks(): Promise<TaskRecord[]> {
  return dbTransaction(STORE_TASKS, 'readonly', (s) => s.getAll())
}

export function putTask(task: TaskRecord): Promise<IDBValidKey> {
  return dbTransaction(STORE_TASKS, 'readwrite', (s) => s.put(task))
}

export function deleteTask(id: string): Promise<undefined> {
  return dbTransaction(STORE_TASKS, 'readwrite', (s) => s.delete(id))
}

export function clearTasks(): Promise<undefined> {
  return dbTransaction(STORE_TASKS, 'readwrite', (s) => s.clear())
}

// ===== Agent conversations =====

export function getAllAgentConversations(): Promise<AgentConversation[]> {
  return dbTransaction(STORE_AGENT_CONVERSATIONS, 'readonly', (s) => s.getAll())
}

export function putAgentConversation(conversation: AgentConversation): Promise<IDBValidKey> {
  return dbTransaction(STORE_AGENT_CONVERSATIONS, 'readwrite', (s) => s.put(conversation))
}

export function deleteAgentConversation(id: string): Promise<undefined> {
  return dbTransaction(STORE_AGENT_CONVERSATIONS, 'readwrite', (s) => s.delete(id))
}

export function clearAgentConversations(): Promise<undefined> {
  return dbTransaction(STORE_AGENT_CONVERSATIONS, 'readwrite', (s) => s.clear())
}

export function replaceAgentConversations(conversations: AgentConversation[]): Promise<undefined> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_AGENT_CONVERSATIONS, 'readwrite')
        const store = tx.objectStore(STORE_AGENT_CONVERSATIONS)
        store.clear()
        for (const conversation of conversations) store.put(conversation)
        tx.oncomplete = () => resolve(undefined)
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      }),
  )
}

// ===== Canvases（画布工作区文档）=====

export function getAllCanvases(): Promise<CanvasDocument[]> {
  return dbTransaction(STORE_CANVASES, 'readonly', (s) => s.getAll())
}

export function putCanvas(canvas: CanvasDocument): Promise<IDBValidKey> {
  return dbTransaction(STORE_CANVASES, 'readwrite', (s) => s.put(canvas))
}

export function deleteCanvas(id: string): Promise<undefined> {
  return dbTransaction(STORE_CANVASES, 'readwrite', (s) => s.delete(id))
}

export function clearCanvases(): Promise<undefined> {
  return dbTransaction(STORE_CANVASES, 'readwrite', (s) => s.clear())
}

export function replaceStoredCanvases(canvases: CanvasDocument[]): Promise<undefined> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_CANVASES, 'readwrite')
        const store = tx.objectStore(STORE_CANVASES)
        store.clear()
        for (const canvas of canvases) store.put(canvas)
        tx.oncomplete = () => resolve(undefined)
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      }),
  )
}

// ===== Images =====

export function getImage(id: string): Promise<StoredImage | undefined> {
  return dbTransaction(STORE_IMAGES, 'readonly', (s) => s.get(id))
}

export function getStoredImageThumbnail(id: string): Promise<StoredImageThumbnail | undefined> {
  return dbTransaction(STORE_THUMBNAILS, 'readonly', (s) => s.get(id))
}

export async function getStoredFreshImageThumbnail(id: string): Promise<StoredImageThumbnail | undefined> {
  const thumbnail = await getStoredImageThumbnail(id)
  return thumbnail?.thumbnailVersion === THUMBNAIL_VERSION ? thumbnail : undefined
}

export function putImageThumbnail(thumbnail: StoredImageThumbnail): Promise<IDBValidKey> {
  return dbTransaction(STORE_THUMBNAILS, 'readwrite', (s) => s.put(thumbnail))
}

export async function getImageThumbnail(id: string): Promise<StoredImageThumbnail | undefined> {
  const existingThumbnail = await getStoredImageThumbnail(id)
  if (existingThumbnail?.thumbnailVersion === THUMBNAIL_VERSION) {
    const image = await getImage(id)
    if (image && (!image.width || !image.height) && existingThumbnail.width && existingThumbnail.height) {
      await putImage({ ...image, width: existingThumbnail.width, height: existingThumbnail.height })
    }
    return existingThumbnail
  }

  const image = await getImage(id)
  if (!image) return undefined
  const legacyImage = image as StoredImage & Partial<StoredImageThumbnail>
  if (legacyImage.thumbnailDataUrl && legacyImage.thumbnailVersion === THUMBNAIL_VERSION) {
    const thumbnail: StoredImageThumbnail = {
      id,
      thumbnailDataUrl: legacyImage.thumbnailDataUrl,
      width: legacyImage.width,
      height: legacyImage.height,
      thumbnailVersion: THUMBNAIL_VERSION,
    }
    await putImageThumbnail(thumbnail)
    if ((!image.width || !image.height) && thumbnail.width && thumbnail.height) {
      await putImage({ ...image, width: thumbnail.width, height: thumbnail.height })
    }
    return thumbnail
  }

  const metadata = await safeCreateImageThumbnail(image.dataUrl)
  if (!metadata.thumbnailDataUrl) return undefined
  const thumbnail: StoredImageThumbnail = {
    id,
    thumbnailDataUrl: metadata.thumbnailDataUrl,
    width: metadata.width,
    height: metadata.height,
    thumbnailVersion: THUMBNAIL_VERSION,
  }
  await putImageThumbnail(thumbnail)
  if (metadata.width && metadata.height && (image.width !== metadata.width || image.height !== metadata.height)) {
    await putImage({ ...image, width: metadata.width, height: metadata.height })
  }
  return thumbnail
}

export function getAllImages(): Promise<StoredImage[]> {
  return dbTransaction(STORE_IMAGES, 'readonly', (s) => s.getAll())
}

export function getAllImageIds(): Promise<string[]> {
  return dbTransaction(STORE_IMAGES, 'readonly', (s) => s.getAllKeys()).then((keys) =>
    keys.map(String),
  )
}

export function putImage(image: StoredImage): Promise<IDBValidKey> {
  return dbTransaction(STORE_IMAGES, 'readwrite', (s) => s.put(image))
}

export function deleteImage(id: string): Promise<undefined> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_IMAGES, STORE_THUMBNAILS], 'readwrite')
        tx.objectStore(STORE_IMAGES).delete(id)
        tx.objectStore(STORE_THUMBNAILS).delete(id)
        tx.oncomplete = () => resolve(undefined)
        tx.onerror = () => reject(tx.error)
      }),
  )
}

export function clearImages(): Promise<undefined> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_IMAGES, STORE_THUMBNAILS], 'readwrite')
        tx.objectStore(STORE_IMAGES).clear()
        tx.objectStore(STORE_THUMBNAILS).clear()
        tx.oncomplete = () => resolve(undefined)
        tx.onerror = () => reject(tx.error)
      }),
  )
}

/**
 * Returns true when an error is an IndexedDB quota / storage-exhausted failure.
 * Browsers surface this as a DOMException whose name is `QuotaExceededError`
 * (write) or `AbortError` with a quota message (transaction abort). We match by
 * name to stay robust across engines.
 */
export function isQuotaExceededError(err: unknown): boolean {
  if (err == null) return false
  const name = (err as { name?: string }).name
  if (name === 'QuotaExceededError' || name === 'QuotaExceeded') return true
  // Some engines abort the whole transaction with a generic error when a put
  // exceeds quota; fall back to a message sniff.
  const msg = (err as { message?: string }).message ?? ''
  return /quota|storage|exceeded/i.test(msg)
}

/**
 * Removes the `count` oldest images (and their thumbnails) from the store,
 * ranked by `createdAt`. Returns the ids that were actually removed. This is a
 * last-resort eviction used when a write hits the quota limit — callers should
 * have already tried deleting orphaned images first.
 */
export async function evictOldestImages(count: number): Promise<string[]> {
  if (count <= 0) return []
  const db = await openDB()
  return await new Promise<string[]>((resolve, reject) => {
    let removedIds: string[] = []
    const tx = db.transaction([STORE_IMAGES, STORE_THUMBNAILS], 'readwrite')
    const images = tx.objectStore(STORE_IMAGES)
    const thumbnails = tx.objectStore(STORE_THUMBNAILS)
    const req = images.getAll()
    req.onsuccess = () => {
      const all = (req.result as StoredImage[]) ?? []
      // Oldest first; entries without createdAt are treated as oldest.
      all.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
      const victims = all.slice(0, count)
      removedIds = victims.map((img) => img.id)
      for (const img of victims) {
        images.delete(img.id)
        thumbnails.delete(img.id)
      }
    }
    tx.oncomplete = () => resolve(removedIds)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

// ===== Videos =====
// 视频缓存到浏览器（IndexedDB），与图片分库；mp4 以 Blob 存储，播放用 URL.createObjectURL。

export function getVideo(id: string): Promise<StoredVideo | undefined> {
  return dbTransaction(STORE_VIDEOS, 'readonly', (s) => s.get(id))
}

export function getAllVideos(): Promise<StoredVideo[]> {
  return dbTransaction(STORE_VIDEOS, 'readonly', (s) => s.getAll())
}

export function getAllVideoIds(): Promise<string[]> {
  return dbTransaction(STORE_VIDEOS, 'readonly', (s) => s.getAllKeys()).then((keys) => keys.map(String))
}

export function putVideo(video: StoredVideo): Promise<IDBValidKey> {
  return dbTransaction(STORE_VIDEOS, 'readwrite', (s) => s.put(video))
}

export function deleteVideo(id: string): Promise<undefined> {
  return dbTransaction(STORE_VIDEOS, 'readwrite', (s) => s.delete(id))
}

export function clearVideos(): Promise<undefined> {
  return dbTransaction(STORE_VIDEOS, 'readwrite', (s) => s.clear())
}

// ===== Image hashing & dedup =====

export async function hashDataUrl(dataUrl: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    return hashDataUrlFallback(dataUrl)
  }

  const data = new TextEncoder().encode(dataUrl)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function hashDataUrlFallback(dataUrl: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193

  for (let i = 0; i < dataUrl.length; i++) {
    const code = dataUrl.charCodeAt(i)
    h1 ^= code
    h1 = Math.imul(h1, 0x01000193)
    h2 ^= code
    h2 = Math.imul(h2, 0x27d4eb2d)
  }

  return `fallback-${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`
}

/**
 * 存储图片，若已存在（按 hash 去重）则跳过。
 * 返回 image id。
 */
export async function storeImage(dataUrl: string, source: NonNullable<StoredImage['source']> = 'upload'): Promise<string> {
  const id = await hashDataUrl(dataUrl)
  const existing = await getImage(id)
  if (!existing) {
    const thumbnail = await safeCreateImageThumbnail(dataUrl)
    await putImage({
      id,
      dataUrl,
      createdAt: Date.now(),
      source,
      width: thumbnail.width,
      height: thumbnail.height,
    })
    if (thumbnail.thumbnailDataUrl) {
      await putImageThumbnail({
        id,
        thumbnailDataUrl: thumbnail.thumbnailDataUrl,
        width: thumbnail.width,
        height: thumbnail.height,
        thumbnailVersion: THUMBNAIL_VERSION,
      })
    }
  } else if ((await getStoredImageThumbnail(id))?.thumbnailVersion !== THUMBNAIL_VERSION) {
    const thumbnail = await safeCreateImageThumbnail(existing.dataUrl)
    if (thumbnail.width && thumbnail.height && (existing.width !== thumbnail.width || existing.height !== thumbnail.height)) {
      await putImage({ ...existing, width: thumbnail.width, height: thumbnail.height })
    }
    if (thumbnail.thumbnailDataUrl) {
      await putImageThumbnail({
        id,
        thumbnailDataUrl: thumbnail.thumbnailDataUrl,
        width: thumbnail.width,
        height: thumbnail.height,
        thumbnailVersion: THUMBNAIL_VERSION,
      })
    }
  }
  return id
}

async function createImageThumbnail(dataUrl: string): Promise<Omit<StoredImageThumbnail, 'id'>> {
  const image = await loadImage(dataUrl)
  const width = image.naturalWidth
  const height = image.naturalHeight
  if (width <= 0 || height <= 0) throw new Error('图片尺寸无效')

  const scale = Math.min(1, THUMBNAIL_MAX_SIZE / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持 Canvas')
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)

  return {
    thumbnailDataUrl: canvas.toDataURL('image/webp', THUMBNAIL_QUALITY),
    width,
    height,
    thumbnailVersion: THUMBNAIL_VERSION,
  }
}

async function safeCreateImageThumbnail(dataUrl: string): Promise<Partial<Omit<StoredImageThumbnail, 'id'>>> {
  try {
    return await createImageThumbnail(dataUrl)
  } catch {
    return {}
  }
}

/**
 * Thrown when an image cannot be persisted even after reclaiming space
 * (orphan eviction + oldest-image eviction + retry). Carries `isStorageFull`
 * so callers can distinguish "the image was generated but we could not save it"
 * from a genuine generation failure — the upstream credit was already spent.
 */
export class StorageFullError extends Error {
  readonly isStorageFull = true
  constructor(message = '浏览器存储已满，无法保存这张图片。请清理历史记录后重试。') {
    super(message)
    this.name = 'StorageFullError'
  }
}

export function isStorageFullError(err: unknown): boolean {
  return err instanceof StorageFullError || (err as { isStorageFull?: boolean })?.isStorageFull === true
}

// ===== Storage health & durability =====
// Browser storage is best-effort: the UA may evict origin data under storage pressure
// unless the origin is granted *persistent* storage. Since user tasks/images live ONLY
// here (never uploaded to the server), these helpers let the app request durability,
// surface usage to the user, and self-check stored-image integrity.

/**
 * Asks the browser to mark this origin's storage as persistent (exempt from automatic
 * eviction). Returns true when persistence is granted (or already granted). Safe to call
 * repeatedly; resolves false when the StorageManager API is unavailable.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false
    if (await navigator.storage.persisted?.()) return true
    return await navigator.storage.persist()
  } catch (error) {
    logger.warn('db', '申请持久化存储失败', { error: serializeError(error) })
    return false
  }
}

/** Whether this origin's storage is currently persisted (won't be auto-evicted). */
export async function isStoragePersisted(): Promise<boolean> {
  try {
    return (await navigator.storage?.persisted?.()) ?? false
  } catch {
    return false
  }
}

export interface StorageEstimateInfo {
  /** Bytes used by this origin (all storage, per the UA estimate — not just our DB). */
  usageBytes: number
  /** Total bytes the UA is willing to grant this origin; 0 when unknown. */
  quotaBytes: number
  /** usage/quota as a 0-100 percentage; 0 when quota is unknown. */
  percentUsed: number
  /** Whether storage is persisted (durable). */
  persisted: boolean
}

/** Best-effort storage usage/quota estimate plus persistence status. */
export async function estimateStorageUsage(): Promise<StorageEstimateInfo> {
  let usageBytes = 0
  let quotaBytes = 0
  try {
    const est = await navigator.storage?.estimate?.()
    usageBytes = est?.usage ?? 0
    quotaBytes = est?.quota ?? 0
  } catch (error) {
    logger.warn('db', '读取存储用量失败', { error: serializeError(error) })
  }
  const persisted = await isStoragePersisted()
  const percentUsed = quotaBytes > 0 ? (usageBytes / quotaBytes) * 100 : 0
  return { usageBytes, quotaBytes, percentUsed, persisted }
}

export interface StorageCounts {
  images: number
  thumbnails: number
  videos: number
  tasks: number
  agentConversations: number
}

function countStore(storeName: string): Promise<number> {
  return dbTransaction(storeName, 'readonly', (s) => s.count())
}

/** Per-store row counts, for the storage health view. */
export async function getStorageCounts(): Promise<StorageCounts> {
  const [images, thumbnails, videos, tasks, agentConversations] = await Promise.all([
    countStore(STORE_IMAGES),
    countStore(STORE_THUMBNAILS),
    countStore(STORE_VIDEOS),
    countStore(STORE_TASKS),
    countStore(STORE_AGENT_CONVERSATIONS),
  ])
  return { images, thumbnails, videos, tasks, agentConversations }
}

export interface IntegrityReport {
  totalImages: number
  /** Images whose stored bytes no longer hash to their id (silent corruption). */
  corrupted: string[]
  /** Images that exist but have no thumbnail row (cosmetic; backfillable). */
  missingThumbnails: number
}

/**
 * Re-hashes every stored image and flags any whose content no longer matches its id —
 * since the id IS the content hash, a mismatch means the stored bytes were corrupted.
 * Manual, user-triggered audit: it reads every image into memory, so it is intentionally
 * never run automatically. Cross-task orphan cleanup is handled at the store layer.
 */
export async function scanStorageIntegrity(): Promise<IntegrityReport> {
  const images = await getAllImages()
  const thumbnailKeys = await dbTransaction<IDBValidKey[]>(STORE_THUMBNAILS, 'readonly', (s) => s.getAllKeys())
  const thumbnailIds = new Set(thumbnailKeys.map(String))
  const corrupted: string[] = []
  let missingThumbnails = 0
  for (const img of images) {
    if (!thumbnailIds.has(img.id)) missingThumbnails++
    const fallbackId = img.id.startsWith('fallback-')
    const expected = fallbackId ? hashDataUrlFallback(img.dataUrl) : await hashDataUrl(img.dataUrl)
    // Only flag when we computed a comparable hash. If we silently fell back to a
    // different scheme than the id was created with, skip it to avoid false positives.
    if (expected !== img.id && expected.startsWith('fallback-') === fallbackId) {
      corrupted.push(img.id)
    }
  }
  return { totalImages: images.length, corrupted, missingThumbnails }
}
