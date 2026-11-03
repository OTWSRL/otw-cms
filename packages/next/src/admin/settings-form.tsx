import { FormField, FormTable, SubmitButton } from '@otwdesign/admin-ui'
import type { SettingField, SettingsPageView } from '@otwdesign/core'

/**
 * One form per page, as in WordPress: the kernel saves only the fields placed on it, so the page
 * key is the one thing the form has to say. Each section is a heading over a form table, as
 * `do_settings_sections()` prints them.
 */
export function SettingsForm({
  view,
  saveUrl,
  entryOptions = {},
}: {
  view: SettingsPageView
  saveUrl: string
  /** The choices for `entry` fields, by content type: its published entries, as a tree. */
  entryOptions?: Readonly<Record<string, readonly { value: string; label: string }[]>>
}) {
  return (
    <form method="post" action={saveUrl}>
      <input type="hidden" name="page" value={view.key} />
      {view.description && <p>{view.description}</p>}
      {view.sections.map((section) => {
        const id = `settings-${section.key.replace('.', '-')}`
        return (
          <section key={section.key} aria-labelledby={id}>
            <h2 id={id}>{section.title}</h2>
            {section.description && <p>{section.description}</p>}
            <FormTable>
              {section.fields.map((field) => (
                <Field
                  key={field.key}
                  field={field}
                  choices={field.contentType ? entryOptions[field.contentType] : undefined}
                />
              ))}
            </FormTable>
          </section>
        )
      })}
      {view.sections.length === 0 && <p>No settings here yet.</p>}
      {view.editable && <SubmitButton>Save Changes</SubmitButton>}
    </form>
  )
}

function Field({
  field,
  choices,
}: {
  field: SettingField
  choices?: readonly { value: string; label: string }[]
}) {
  const id = `setting-${field.key.replace(/\W/g, '-')}`
  const helpId = `${id}-description`
  const envNote = field.locked && field.env && (
    <>
      {' '}
      Set by the <code>{field.env}</code> environment variable.
    </>
  )
  const help = (field.description || envNote) && (
    <>
      {field.description}
      {envNote}
    </>
  )
  const described = help ? helpId : undefined

  if (field.type === 'secret') {
    return (
      <FormField label={field.label} description={help} descriptionId={helpId}>
        <span className="field-value">{field.configured ? 'Configured' : 'Not set'}</span>
      </FormField>
    )
  }
  if (field.type === 'boolean') {
    return (
      <FormField label={field.label} htmlFor={id} description={help} descriptionId={helpId}>
        <input
          id={id}
          type="checkbox"
          name={field.key}
          defaultChecked={field.value === true}
          disabled={field.locked}
          aria-describedby={described}
        />
      </FormField>
    )
  }
  if (field.type === 'entry') {
    const value = typeof field.value === 'string' ? field.value : ''
    return (
      <FormField label={field.label} htmlFor={id} description={help} descriptionId={helpId}>
        <select
          id={id}
          name={field.key}
          defaultValue={value}
          disabled={field.locked}
          aria-describedby={described}
        >
          <option value="">— Select —</option>
          {/* A chosen entry that's since been unpublished stays chosen until changed. */}
          {value && !choices?.some((choice) => choice.value === value) && (
            <option value={value}>(not published)</option>
          )}
          {choices?.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </FormField>
    )
  }
  if (field.type === 'select') {
    return (
      <FormField label={field.label} htmlFor={id} description={help} descriptionId={helpId}>
        <select
          id={id}
          name={field.key}
          defaultValue={String(field.value ?? '')}
          disabled={field.locked}
          aria-describedby={described}
        >
          {field.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </FormField>
    )
  }
  return (
    <FormField label={field.label} htmlFor={id} description={help} descriptionId={helpId}>
      <input
        id={id}
        name={field.key}
        className="regular-text"
        defaultValue={typeof field.value === 'string' ? field.value : ''}
        disabled={field.locked}
        aria-describedby={described}
      />
    </FormField>
  )
}
