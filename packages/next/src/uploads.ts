import { getKernel } from './runtime/kernel'

/** `/uploads/[...path]`: files from the media library's storage, like `wp-content/uploads`. */
async function handle(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const kernel = await getKernel()
  const { path } = await params
  return kernel.serveUpload(request, path.join('/'))
}

export { handle as GET, handle as HEAD }
