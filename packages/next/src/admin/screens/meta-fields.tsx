import { FormField, FormTable } from '@otw/admin-ui'
import { metaOptions } from '@otw/core'
import type { EntryMetaValues, MetaField } from '@otw/sdk'

/** The input for one field, named `meta.{key}`, or shown disabled and unnamed when read-only. */
function Input({
  field,
  id,
  value,
  editable,
  describedBy,
}: {
  field: MetaField
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
}: {
  fields: readonly MetaField[]
  /** The entry's values with defaults, or `{}` on Add New. */
  meta: EntryMetaValues
  editable(field: MetaField): boolean
}) {
  return (
    <FormTable>
      {fields.map((field) => {
        const canEdit = editable(field)
        const id = `meta-${field.key.replace('.', '-')}`
        const value =
          (meta as Record<string, unknown>)[field.key] ?? field.definition.default ?? undefined
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
            {canEdit && <input type="hidden" name="metaFields" value={field.key} />}
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
