import { rm } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { bootSite, dataDir, openDatabase, uploadsFromEnv } from '@otwdesign/next/server'
import { site } from '../src/cms/site.generated'

const DEMO_PRODUCTS = [
  { slug: 'ceramic-mug', title: 'Ceramic Mug', description: 'Stoneware, 350 ml.', price: 1800 },
  {
    slug: 'field-notebook',
    title: 'Field Notebook',
    description: 'Dot grid, 96 pages.',
    price: 1200,
  },
  { slug: 'canvas-tote', title: 'Canvas Tote', description: 'Heavy cotton canvas.', price: 2400 },
]

/**
 * `--reset` wipes the local PGlite data and the uploads first. It refuses to touch anything
 * outside ./.data.
 */
async function resetLocalData(): Promise<void> {
  if (process.env.DATABASE_URL) throw new Error('--reset only works with the embedded database')
  for (const dir of [dataDir(), uploadsFromEnv(process.env).dir]) {
    if (!dir.startsWith(resolve('.data') + sep))
      throw new Error(`Refusing to delete ${dir}: not under ./.data`)
    await rm(dir, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--reset')) await resetLocalData()

  const { db, close } = openDatabase()
  try {
    const kernel = await bootSite(site, db)
    if (!kernel.isActive('commerce')) {
      console.log('seed: commerce is not active, nothing to seed')
      return
    }
    const commerce = kernel.service('commerce')
    const existing = new Set((await commerce.listProducts()).map((product) => product.slug))
    const missing = DEMO_PRODUCTS.filter((product) => !existing.has(product.slug))
    for (const product of missing) await commerce.createProduct(product)
    console.log(`seed: added ${missing.length} demo products`)
  } finally {
    await close()
  }
}

main().catch((error: unknown) => {
  console.error('seed failed:', error)
  process.exitCode = 1
})
