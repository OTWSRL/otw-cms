import {
  FormButton,
  FormField,
  FormTable,
  ListTable,
  Notice,
  SubmitButton,
} from '@otwdesign/admin-ui'
import { MAX_FAILURES, type StoredWebhook, type WebhookStatus } from '@otwdesign/core'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { firstParam } from '../../runtime/search-params'
import { AdminScreen } from '../screen'
import type { ScreenContext } from './context'
import { formatDate } from './content-dates'

const PATH = '/admin/settings/webhooks'
const NEW = 'new'

const STATUSES: readonly { status: WebhookStatus; label: string }[] = [
  { status: 'active', label: 'Active' },
  { status: 'paused', label: 'Paused' },
  { status: 'disabled', label: 'Disabled' },
]

const statusLabel = (status: WebhookStatus) =>
  STATUSES.find((entry) => entry.status === status)!.label

/** A status code as a sentence, or the reason there was none. */
function resultText(result: string): string {
  return /^\d{3}$/.test(result) ? `The endpoint answered ${result}.` : result
}

function LastDelivery({ hook, locale }: { hook: StoredWebhook; locale: string | undefined }) {
  if (!hook.lastDeliveryAt) return <>None yet</>
  return (
    <>
      <time dateTime={hook.lastDeliveryAt.toISOString()}>
        {formatDate(hook.lastDeliveryAt, locale)}
      </time>
      <br />
      <span className={/^2\d\d$/.test(hook.lastResult ?? '') ? 'description' : 'job-error'}>
        {resultText(hook.lastResult ?? '')}
      </span>
    </>
  )
}

/**
 * Settings › Webhooks, as WooCommerce has its own under its settings: where the site sends its
 * events. The list, and with `?edit=` one webhook's form, as `&edit-webhook=` does there.
 */
export async function WebhooksScreen({ kernel, searchParams: params }: ScreenContext) {
  const flash = kernel.readFlash(params.flash)
  const editing = firstParam(params.edit)
  const events = kernel.webhooks.events()
  const labels = new Map(events.map((event) => [event.name, event.label]))
  const locale = kernel.setting('site.locale')

  if (editing) {
    const hook = editing === NEW ? null : await kernel.webhooks.get(editing)
    if (editing !== NEW && !hook) {
      return (
        <AdminScreen title="Webhooks" flash={flash}>
          <Notice type="error" title="That webhook no longer exists.">
            <p>
              <a href={PATH}>← Go to Webhooks</a>
            </p>
          </Notice>
        </AdminScreen>
      )
    }
    return (
      <AdminScreen
        title={hook ? 'Edit Webhook' : 'Add Webhook'}
        titleAction={hook ? { label: 'Add Webhook', url: `${PATH}?edit=${NEW}` } : null}
        flash={flash}
      >
        <p>
          <a href={PATH}>← Go to Webhooks</a>
        </p>
        {hook?.status === 'disabled' && (
          <Notice type="warning" title="This webhook is disabled.">
            <p>
              {hook.failures >= MAX_FAILURES
                ? `It was switched off after ${hook.failures} deliveries in a row failed. `
                : ''}
              Once its endpoint answers again, set its status to Active and save.
            </p>
          </Notice>
        )}
        <WebhookForm
          hook={hook}
          events={events}
          saveUrl={kernel.actionUrl('core', 'save-webhook')}
          lastDelivery={hook ? <LastDelivery hook={hook} locale={locale} /> : null}
        />
        {hook && (
          <>
            <h2>Deliveries</h2>
            <p>
              Each event is sent as a POST with a JSON body, and tried up to five times. Every
              delivery, with why it failed, is in{' '}
              <Link href="/admin/tools/scheduled-actions?s=core.deliver_webhook">
                Tools › Scheduled Actions
              </Link>
              .
            </p>
            <div className="para">
              <FormButton
                action={kernel.actionUrl('core', 'test-webhook')}
                fields={{ id: hook.id }}
              >
                Send a test
              </FormButton>{' '}
              <FormButton
                action={kernel.actionUrl('core', 'delete-webhook')}
                fields={{ id: hook.id }}
                variant="delete"
              >
                Delete this webhook
              </FormButton>
            </div>
          </>
        )}
      </AdminScreen>
    )
  }

  const hooks = await kernel.webhooks.list()
  return (
    <AdminScreen
      title="Webhooks"
      titleAction={{ label: 'Add Webhook', url: `${PATH}?edit=${NEW}` }}
      flash={flash}
    >
      <p>
        A webhook tells another system when something happens on this site: each event you choose is
        sent to its address as it happens.
      </p>
      <ListTable
        caption="Webhooks"
        rows={hooks}
        rowKey={(hook) => hook.id}
        empty="No webhooks yet."
        rowActions={(hook) => [
          <a key="edit" href={`${PATH}?edit=${hook.id}`} aria-label={`Edit “${hook.name}”`}>
            Edit
          </a>,
          <FormButton
            key="delete"
            action={kernel.actionUrl('core', 'delete-webhook')}
            fields={{ id: hook.id }}
            variant="delete"
            aria-label={`Delete “${hook.name}”`}
          >
            Delete
          </FormButton>,
        ]}
        columns={[
          {
            key: 'name',
            label: 'Name',
            render: (hook) => (
              <strong>
                <a className="row-title" href={`${PATH}?edit=${hook.id}`}>
                  {hook.name}
                </a>
              </strong>
            ),
          },
          { key: 'status', label: 'Status', render: (hook) => statusLabel(hook.status) },
          {
            key: 'events',
            label: 'Events',
            render: (hook) => hook.topics.map((topic) => labels.get(topic) ?? topic).join(', '),
          },
          { key: 'url', label: 'Delivery URL', render: (hook) => <code>{hook.url}</code> },
          {
            key: 'last',
            label: 'Last delivery',
            render: (hook) => <LastDelivery hook={hook} locale={locale} />,
          },
        ]}
      />
    </AdminScreen>
  )
}

function WebhookForm({
  hook,
  events,
  saveUrl,
  lastDelivery,
}: {
  hook: StoredWebhook | null
  events: ReturnType<ScreenContext['kernel']['webhooks']['events']>
  saveUrl: string
  lastDelivery: ReactNode
}) {
  // An event whose plugin is inactive stays ticked, so saving doesn't drop it.
  const known = new Set(events.map((event) => event.name))
  const orphans = (hook?.topics ?? []).filter((topic) => !known.has(topic))
  return (
    <form method="post" action={saveUrl}>
      {hook && <input type="hidden" name="id" value={hook.id} />}
      <FormTable>
        <FormField label="Name" htmlFor="webhook-name" description="What you call it.">
          <input
            id="webhook-name"
            name="name"
            className="regular-text"
            defaultValue={hook?.name ?? ''}
            maxLength={100}
            required
            autoComplete="off"
          />
        </FormField>
        <FormField
          label="Status"
          htmlFor="webhook-status"
          description="Only an active webhook is sent events. A paused or disabled one misses those that happen meanwhile."
        >
          <select id="webhook-status" name="status" defaultValue={hook?.status ?? 'active'}>
            {STATUSES.map(({ status, label }) => (
              <option key={status} value={status}>
                {label}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Events">
          <fieldset>
            <legend className="screen-reader-text">Events</legend>
            {events.map((event) => (
              <label key={event.name} className="webhook-event">
                <input
                  type="checkbox"
                  name="topics"
                  value={event.name}
                  defaultChecked={hook?.topics.includes(event.name) ?? false}
                />{' '}
                {event.label} <code>{event.name}</code>
                {event.description && <span className="description"> {event.description}</span>}
              </label>
            ))}
            {orphans.map((topic) => (
              <label key={topic} className="webhook-event">
                <input type="checkbox" name="topics" value={topic} defaultChecked />{' '}
                <code>{topic}</code>
                <span className="description"> Its plugin isn’t active.</span>
              </label>
            ))}
          </fieldset>
        </FormField>
        <FormField
          label="Delivery URL"
          htmlFor="webhook-url"
          description="Where each event is sent, as a POST with a JSON body. A redirect from it isn’t followed."
        >
          <input
            id="webhook-url"
            type="url"
            name="url"
            className="regular-text code"
            defaultValue={hook?.url ?? ''}
            placeholder="https://example.com/webhooks"
            maxLength={2000}
            required
          />
        </FormField>
        {hook && (
          <>
            <FormField
              label="Secret"
              htmlFor="webhook-secret"
              description="Signs every delivery, so the receiver can check it came from this site: the webhook-signature header, as the Standard Webhooks specification has it."
            >
              <input
                id="webhook-secret"
                className="regular-text code"
                value={hook.secret}
                readOnly
              />
              <br />
              <label>
                <input type="checkbox" name="new_secret" value="1" /> Replace it with a new secret
              </label>
            </FormField>
            <FormField label="Last delivery">{lastDelivery}</FormField>
          </>
        )}
      </FormTable>
      <SubmitButton>{hook ? 'Save Webhook' : 'Add Webhook'}</SubmitButton>
    </form>
  )
}
