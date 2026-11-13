import { ButtonLink, FormField, FormTable, SubmitButton } from '@otwdesign/admin-ui'
import type { SettingField, SettingVisibility, SettingsPageView } from '@otwdesign/core'
import type { SettingPair } from '@otwdesign/sdk'
import { PairsField } from './pairs-field'
import { hiddenRule } from './settings-visibility'

/**
 * How a field or a section that shows only sometimes is marked: by a name a style rule hides
 * it by while the form says so, or as hidden outright when nothing on this page decides it.
 * Hidden either way, its controls stay in the form, so saving keeps their values.
 */
function shownBy(target: string, visibility: SettingVisibility | undefined) {
  if (!visibility) return {}
  return visibility.groups.length === 0 ? { hidden: true } : { 'data-show': target }
}

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
  const formId = `settings-form-${view.key.replace(/\W/g, '-')}`
  const conditional = [
    ...view.sections.map((section) => [section.key, section.visibility] as const),
    ...view.sections.flatMap((section) =>
      section.fields.map((field) => [field.key, field.visibility] as const),
    ),
  ]
  const rules = conditional.flatMap(([target, visibility]) => {
    const rule = visibility ? hiddenRule(formId, target, visibility) : null
    return rule ? [rule] : []
  })
  return (
    <form method="post" action={saveUrl} id={formId}>
      {rules.length > 0 && (
        <style href={formId} precedence="default">
          {rules.join('\n')}
        </style>
      )}
      <input type="hidden" name="page" value={view.key} />
      {view.description && <p>{view.description}</p>}
      {view.sections.map((section) => {
        const id = `settings-${section.key.replace('.', '-')}`
        return (
          <section
            key={section.key}
            aria-labelledby={id}
            {...shownBy(section.key, section.visibility)}
          >
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
            {section.link && (
              <p>
                <ButtonLink href={section.link.url}>{section.link.label}</ButtonLink>
              </p>
            )}
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
  const row = shownBy(field.key, field.visibility)

  if (field.type === 'roles') {
    const chosen = Array.isArray(field.value) ? (field.value as readonly string[]) : []
    return (
      <FormField label={field.label} description={help} descriptionId={helpId} row={row}>
        <fieldset aria-describedby={described}>
          <legend className="screen-reader-text">{field.label}</legend>
          {field.options?.map((role) => (
            <label key={role.value} className="setting-choice">
              <input
                type="checkbox"
                name={field.key}
                value={role.value}
                defaultChecked={chosen.includes(role.value)}
                disabled={field.locked}
              />{' '}
              {role.label}
            </label>
          ))}
        </fieldset>
      </FormField>
    )
  }
  if (field.type === 'pairs' && field.columns) {
    return (
      <FormField
        label={field.label}
        htmlFor={id}
        description={help}
        descriptionId={helpId}
        row={row}
      >
        <PairsField
          name={field.key}
          id={id}
          label={field.label}
          rows={Array.isArray(field.value) ? (field.value as readonly SettingPair[]) : []}
          columns={field.columns}
          disabled={field.locked}
          describedBy={described}
        />
      </FormField>
    )
  }
  if (field.type === 'secret') {
    return (
      <FormField label={field.label} description={help} descriptionId={helpId} row={row}>
        <span className="field-value">{field.configured ? 'Configured' : 'Not set'}</span>
      </FormField>
    )
  }
  if (field.type === 'boolean') {
    return (
      <FormField
        label={field.label}
        htmlFor={id}
        description={help}
        descriptionId={helpId}
        row={row}
      >
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
      <FormField
        label={field.label}
        htmlFor={id}
        description={help}
        descriptionId={helpId}
        row={row}
      >
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
      <FormField
        label={field.label}
        htmlFor={id}
        description={help}
        descriptionId={helpId}
        row={row}
      >
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
  const text = typeof field.value === 'string' ? field.value : ''
  return (
    <FormField label={field.label} htmlFor={id} description={help} descriptionId={helpId} row={row}>
      {field.multiline ? (
        <textarea
          id={id}
          name={field.key}
          className="large-text code"
          rows={Math.min(12, Math.max(4, text.split('\n').length + 1))}
          defaultValue={text}
          disabled={field.locked}
          aria-describedby={described}
          spellCheck={false}
        />
      ) : (
        <input
          id={id}
          name={field.key}
          className="regular-text"
          defaultValue={text}
          disabled={field.locked}
          aria-describedby={described}
        />
      )}
    </FormField>
  )
}
