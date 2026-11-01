import type { ApiHandler, PluginContext } from '@otw/sdk'
import { HttpError } from '@otw/sdk'
import { z } from 'zod'
import { CommerceError, type CommerceErrorCode } from '../errors'
import { MAX_QUANTITY } from '../service'
import type { CommerceService } from '../types'

const lineSchema = z.object({
  type: z.string().min(1).max(64),
  id: z.string().min(1).max(128),
  quantity: z.coerce.number().int().min(1).max(MAX_QUANTITY),
})

const checkoutSchema = z.object({
  email: z.email().max(254),
  gateway: z.string().min(1).max(64),
  lines: z.array(lineSchema).min(1).max(50),
})

/** Query parameter the product page reads to explain why a form checkout bounced back. */
export const CHECKOUT_ERROR_PARAM = 'checkout_error'

const STATUS: Record<CommerceErrorCode, number> = {
  invalid_input: 400,
  unknown_gateway: 400,
  unknown_item: 400,
  invalid_total: 400,
  payment_failed: 502,
  order_not_found: 404,
  product_not_found: 404,
  payment_mismatch: 409,
  invalid_state: 409,
}

/**
 * Accepts JSON (for headless clients) and plain HTML form posts (so checkout works without
 * client-side JavaScript). Forms get redirects; JSON clients get JSON.
 */
export function createCheckoutHandler(cms: PluginContext, commerce: CommerceService): ApiHandler {
  return async (request) => {
    const isForm = isFormRequest(request)
    const fail = (code: CommerceErrorCode, message: string, details?: unknown): Response => {
      if (isForm) return redirect(backTo(request, cms, code))
      throw new HttpError(STATUS[code], message, details)
    }

    const parsed = checkoutSchema.safeParse(
      isForm ? formInput(await request.formData()) : await readJson(request),
    )
    if (!parsed.success) {
      return fail(
        'invalid_input',
        'Check your details and try again',
        z.flattenError(parsed.error).fieldErrors,
      )
    }

    try {
      const { order, payment } = await commerce.checkout(parsed.data, {
        baseUrl: siteUrl(cms, request),
      })
      if (isForm) {
        return redirect(
          payment.type === 'redirect'
            ? payment.url
            : cms.routes.url('commerce.order-received', { id: order.id }),
        )
      }
      return Response.json(
        {
          order: {
            id: order.id,
            number: order.number,
            status: order.status,
            total: order.total,
            currency: order.currency,
          },
          payment,
        },
        { status: 201 },
      )
    } catch (error) {
      if (error instanceof CommerceError) return fail(error.code, error.message)
      throw error
    }
  }
}

function isFormRequest(request: Request): boolean {
  const type = request.headers.get('content-type') ?? ''
  return (
    type.startsWith('application/x-www-form-urlencoded') || type.startsWith('multipart/form-data')
  )
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON')
  }
}

function formInput(form: FormData) {
  return {
    email: form.get('email'),
    gateway: form.get('gateway'),
    lines: [
      {
        type: form.get('item_type'),
        id: form.get('item_id'),
        quantity: form.get('quantity') ?? '1',
      },
    ],
  }
}

function siteUrl(cms: PluginContext, request: Request): string {
  return (cms.settings.get('site.url') ?? new URL(request.url).origin).replace(/\/+$/, '')
}

/** Back to the same-origin page that posted the form, or the shop. Never an external URL. */
function backTo(request: Request, cms: PluginContext, code: CommerceErrorCode): string {
  const origin = new URL(request.url).origin
  let target = new URL(cms.routes.url('commerce.shop'), origin)
  const referer = request.headers.get('referer')
  if (referer) {
    try {
      const candidate = new URL(referer)
      if (candidate.origin === origin) target = candidate
    } catch {
      // Malformed Referer: fall back to the shop.
    }
  }
  target.searchParams.set(CHECKOUT_ERROR_PARAM, code)
  return target.pathname + target.search
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } })
}
