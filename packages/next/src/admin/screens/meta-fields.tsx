import { FormField, FormTable } from '@otwdesign/admin-ui'
import { metaOptions } from '@otwdesign/core'
import type { MetaField, UserMetaField } from '@otwdesign/sdk'

/** An entry's custom field or a user's field: both are shown the same way. */
type Field = MetaField | UserMetaField

/** The input for one field, named `meta.{key}`, or shown disabled and unnamed when read-only. */
function Input({
  field,
  id,
  value,
  editable,
  describedBy,
}: {
  field: Field
  id: string
  value: unknown
  editable: boolean
  describedBy: string | undefined
}) {
  const { definition, key } = field
  const common = {
    id,
    name: editable ? `meta.${key}` : undefined,
    disabled: !editable,
    'aria-describedby': describedBy,
  }
  switch (definition.type) {
    case 'boolean':
      return <input type="checkbox" {...common} defaultChecked={value === true} />
    case 'number':
      return (
        <input
          type="number"
          {...common}
          className="small-text"
          step={definition.integer ? 1 : 'any'}
          min={definition.min}
          max={definition.max}
          defaultValue={typeof value === 'number' ? value : ''}
        />
      )
    case 'strings':
      return (
        <textarea
          {...common}
          rows={4}
          className="large-text"
          defaultValue={Array.isArray(value) ? value.join('\n') : ''}
        />
      )
    case 'json':
      return (
        <textarea
          {...common}
          rows={6}
          className="large-text code"
          defaultValue={value === undefined ? '' : JSON.stringify(value, null, 2)}
        />
      )
    case 'string': {
      const text = typeof value === 'string' ? value : ''
      const choices = metaOptions(definition)
      if (choices.length > 0) {
        return (
          <select {...common} defaultValue={text}>
            {!choices.some((choice) => choice.value === text) && <option value="">—</option>}
            {choices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        )
      }
      return definition.multiline ? (
        <textarea {...common} rows={4} className="large-text" defaultValue={text} />
      ) : (
        <input
          type="text"
          {...common}
          className="regular-text"
          maxLength={definition.maxLength}
          defaultValue={text}
        />
      )
    }
  }
}

/**
 * A field box's custom fields as a form table, like a settings section: each field's input, its
 * value or default filled in. `metaFields` names the fields the save may change, so an unticked
 * checkbox counts as false and fields the user may not change are left alone.
 */
export function MetaFields({
  fields,
  meta,
  editable,
  listName = 'metaFields',
}: {
  fields: readonly Field[]
  /** The values with defaults, or `{}` on Add New. */
  meta: Readonly<Record<string, unknown>>
  editable(field: Field): boolean
  /** The hidden input naming the fields the form may change: `userFields` for users'. */
  listName?: string
}) {
  return (
    <FormTable>
      {fields.map((field) => {
        const canEdit = editable(field)
        const id = `meta-${field.key.replace('.', '-')}`
        const value = meta[field.key] ?? field.definition.default ?? undefined
        const { description, type } = field.definition
        const hint =
          type === 'strings'
            ? [description, 'One per line.'].filter(Boolean).join(' ')
            : description
        return (
          <FormField
            key={field.key}
            label={field.definition.label}
            htmlFor={id}
            description={hint && <span id={`${id}-description`}>{hint}</span>}
          >
            {canEdit && <input type="hidden" name={listName} value={field.key} />}
            <Input
              field={field}
              id={id}
              value={value}
              editable={canEdit}
              describedBy={hint ? `${id}-description` : undefined}
            />
          </FormField>
        )
      })}
    </FormTable>
  )
}
