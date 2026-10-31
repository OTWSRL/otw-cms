import { getKernel } from '@/cms/kernel'

export const dynamic = 'force-dynamic'

/** Every plugin API route lives under /api/p/{pluginId}; the kernel routes, guards and dispatches. */
async function handle(request: Request): Promise<Response> {
  const kernel = await getKernel()
  return kernel.handleApi(request)
}

export { handle as DELETE, handle as GET, handle as PATCH, handle as POST, handle as PUT }
