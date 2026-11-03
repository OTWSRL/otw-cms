import { formatBytes, type Kernel } from '@otwdesign/core'
import type { SearchParams } from '@otwdesign/sdk'
import { AdminScreen } from '../screen'
import { MediaUploader } from './media-uploader'

/** media-new.php: Upload New Media. */
export function MediaNewScreen({
  kernel,
  searchParams,
}: {
  kernel: Kernel
  searchParams: SearchParams
}) {
  const limit = formatBytes(kernel.maxUploadBytes)
  return (
    <AdminScreen title="Upload New Media" flash={kernel.readFlash(searchParams.flash)}>
      <MediaUploader
        action={kernel.actionUrl('core', 'upload-media')}
        api="/api/p/core/media"
        maxBytes={kernel.maxUploadBytes}
        limit={limit}
      />
      <p className="max-upload-size">Maximum upload file size: {limit}.</p>
    </AdminScreen>
  )
}
