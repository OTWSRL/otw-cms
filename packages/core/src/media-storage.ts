import { createReadStream } from 'node:fs'
import { mkdir, open, stat, unlink } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import type { MediaStorage } from '@otw/sdk'
import { isSafeKey } from './media-files'

/** Where uploads are served from, for storage that keeps them on this site. */
export const UPLOADS_PATH = '/uploads'

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Uploads on the site's disk, under `dir`, like WordPress's `wp-content/uploads`, served at
 * `/uploads/…` by the CMS's route. Keys are checked again here, so none reaches outside `dir`.
 */
export function localStorage(dir: string): MediaStorage {
  const root = resolve(dir)
  const pathOf = (key: string): string => {
    const path = resolve(join(root, key))
    if (!isSafeKey(key) || !path.startsWith(root + sep)) {
      throw new Error(`Not a storage key: "${key}"`)
    }
    return path
  }
  const fileStat = async (path: string) => {
    try {
      const info = await stat(path)
      return info.isFile() ? info : null
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  return {
    async create(key, data) {
      const path = pathOf(key)
      await mkdir(dirname(path), { recursive: true })
      let file
      try {
        // `wx` fails when the file exists: two uploads can't claim one name.
        file = await open(path, 'wx')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw error
      }
      try {
        await file.writeFile(data)
      } catch (error) {
        await file.close()
        // The write's error is the one to report; this only removes the partial file it left.
        await unlink(path).catch(() => {})
        throw error
      }
      await file.close()
      return true
    },

    async read(key, range) {
      const path = pathOf(key)
      const info = await fileStat(path)
      if (!info) return null
      const stream = createReadStream(path, range ?? {})
      return {
        body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
        size: info.size,
        modifiedAt: info.mtime,
      }
    },

    async stat(key) {
      const info = await fileStat(pathOf(key))
      return info ? { size: info.size, modifiedAt: info.mtime } : null
    },

    async delete(key) {
      try {
        await unlink(pathOf(key))
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    },

    url: (key) => `${UPLOADS_PATH}/${key}`,
  }
}
