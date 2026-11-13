'use client'

import { useState } from 'react'

interface Row {
  id: number
  name: string
  value: string
}

/**
 * A `pairs` setting's rows: a name and a value each, with a button to add one and one to remove
 * each. Every row posts as `{name}.name` and `{name}.value`; the server drops the empty ones, so
 * the row waiting to be filled in costs nothing. Without JavaScript, the rows there are still
 * edit and save.
 */
export function PairsField({
  name,
  id,
  label,
  rows: initial,
  columns,
  disabled = false,
  describedBy,
}: {
  /** The setting's key. */
  name: string
  id: string
  /** The setting's own label, which names the group of rows. */
  label: string
  rows: readonly { name: string; value: string }[]
  columns: { name: string; value: string; maxRows: number }
  disabled?: boolean
  describedBy?: string
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    [...initial, { name: '', value: '' }].map((row, index) => ({ ...row, id: index })),
  )
  const [nextId, setNextId] = useState(initial.length + 1)
  const change = (row: Row, field: 'name' | 'value', text: string) =>
    setRows((all) =>
      all.map((other) => (other.id === row.id ? { ...other, [field]: text } : other)),
    )
  const add = () => {
    setRows((all) => [...all, { id: nextId, name: '', value: '' }])
    setNextId(nextId + 1)
  }

  return (
    <div className="setting-pairs" role="group" aria-label={label} aria-describedby={describedBy}>
      <table className="setting-pairs-rows" role="presentation">
        <thead>
          <tr>
            <th id={`${id}-name`}>{columns.name}</th>
            <th id={`${id}-value`}>{columns.value}</th>
            <td />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.id}>
              <td>
                <input
                  id={index === 0 ? id : undefined}
                  name={`${name}.name`}
                  value={row.name}
                  onChange={(event) => change(row, 'name', event.target.value)}
                  aria-labelledby={`${id}-name`}
                  disabled={disabled}
                  autoComplete="off"
                  spellCheck={false}
                />
              </td>
              <td>
                <input
                  name={`${name}.value`}
                  value={row.value}
                  onChange={(event) => change(row, 'value', event.target.value)}
                  aria-labelledby={`${id}-value`}
                  disabled={disabled}
                  autoComplete="off"
                  spellCheck={false}
                />
              </td>
              <td>
                {!disabled && (
                  <button
                    type="button"
                    className="button-link button-link-delete"
                    onClick={() => setRows((all) => all.filter((other) => other.id !== row.id))}
                    aria-label={`Remove ${row.name || `row ${index + 1}`}`}
                  >
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!disabled && rows.length < columns.maxRows && (
        <button type="button" className="button button-small" onClick={add}>
          Add Row
        </button>
      )}
    </div>
  )
}
