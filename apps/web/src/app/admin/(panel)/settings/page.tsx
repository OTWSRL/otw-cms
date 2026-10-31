import type { SettingField } from '@cms/core'
import type { SearchParams } from '@cms/sdk'
import type { Metadata } from 'next'
import { AdminScreen } from '@/components/admin'
import { requireAdmin } from '@/cms/session'

export const metadata: Metadata = { title: 'Settings' }

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [{ kernel }, params] = await Promise.all([
    requireAdmin('/admin/settings', 'core.manage_settings'),
    searchParams,
  ])
  const saveUrl = kernel.actionUrl('core', 'save-settings')

  return (
    <AdminScreen title="Settings" flash={kernel.readFlash(params.flash)}>
      {kernel.settingsSections().map((section) => (
        <section
          key={section.id}
          aria-labelledby={`settings-${section.id}`}
          className="cms-section"
        >
          <h2 id={`settings-${section.id}`}>{section.label}</h2>
          <form method="post" action={saveUrl} className="cms-form">
            <input type="hidden" name="section" value={section.id} />
            {section.fields.map((field) => (
              <Field key={field.key} field={field} />
            ))}
            {section.fields.some((field) => !field.locked) && (
              <button type="submit" className="cms-button">
                Save {section.label} settings
              </button>
            )}
          </form>
        </section>
      ))}
    </AdminScreen>
  )
}

function Field({ field }: { field: SettingField }) {
  const helpId = `${field.key}-help`
  const help = (
    <small id={helpId}>
      {field.description}
      {field.locked && field.env && (
        <>
          {' '}
          Set by the <code>{field.env}</code> environment variable.
        </>
      )}
    </small>
  )

  if (field.type === 'secret') {
    return (
      <div className="cms-field">
        <span>{field.label}</span>
        <strong>{field.configured ? 'Configured' : 'Not set'}</strong>
        {help}
      </div>
    )
  }
  if (field.type === 'boolean') {
    return (
      <label className="cms-checkbox">
        <input
          type="checkbox"
          name={field.key}
          defaultChecked={field.value === true}
          disabled={field.locked}
          aria-describedby={helpId}
        />
        {field.label}
        {help}
      </label>
    )
  }
  if (field.type === 'select') {
    return (
      <label>
        {field.label}
        <select
          name={field.key}
          defaultValue={String(field.value ?? '')}
          disabled={field.locked}
          aria-describedby={helpId}
        >
          {field.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {help}
      </label>
    )
  }
  return (
    <label>
      {field.label}
      <input
        name={field.key}
        defaultValue={typeof field.value === 'string' ? field.value : ''}
        disabled={field.locked}
        aria-describedby={helpId}
      />
      {help}
    </label>
  )
}
