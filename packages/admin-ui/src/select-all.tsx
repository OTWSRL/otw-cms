'use client'

/** The checkbox in a list table's header that ticks every row's box (`#cb-select-all`). */
export function SelectAll({ name }: { name: string }) {
  return (
    <input
      type="checkbox"
      aria-label="Select all"
      onChange={(event) => {
        const table = event.currentTarget.closest('table')
        for (const box of table?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ??
          []) {
          if (box.name === name) box.checked = event.currentTarget.checked
        }
      }}
    />
  )
}
