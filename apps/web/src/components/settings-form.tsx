import type { SettingField, SettingsPageView } from '@cms/core'

/**
 * One form per page, as in WordPress: the kernel saves only the fields placed on it, so the page
 * key is the one thing the form has to say.
 */
export function SettingsForm({ view, saveUrl }: { view: SettingsPageView; saveUrl: string }) {
  return (
    <form method="post" action={saveUrl} className="cms-settings">
      <input type="hidden" name="page" value={view.key} />
      {view.description && <p>{view.description}</p>}
      {view.sections.map((section) => {
        const id = `settings-${section.key.replace('.', '-')}`
        return (
          <section key={section.key} aria-labelledby={id} className="cms-section cms-form">
            <h2 id={id}>{section.title}</h2>
            {section.description && (
              <p className="cms-section-description">{section.description}</p>
            )}
            {section.fields.map((field) => (
              <Field key={field.key} field={field} />
            ))}
          </section>
        )
      })}
      {view.sections.length === 0 && <p>No settings here yet.</p>}
      {view.editable && (
        <p className="cms-form-actions">
          <button type="submit" className="cms-button">
            Save changes
          </button>
        </p>
      )}
    </form>
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
