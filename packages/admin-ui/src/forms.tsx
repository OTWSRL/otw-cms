import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Button } from './button'

/** Label on the left, control on the right; one row per field below 783px (`.form-table`). */
export function FormTable({ children }: { children: ReactNode }) {
  return (
    <table className="form-table" role="presentation">
      <tbody>{children}</tbody>
    </table>
  )
}

/**
 * One row of a form table. Pass `htmlFor` to label a single control; leave it out for a group,
 * such as checkboxes in a fieldset, which labels itself.
 */
export function FormField({
  label,
  htmlFor,
  description,
  descriptionId,
  row,
  children,
}: {
  label: ReactNode
  htmlFor?: string
  description?: ReactNode
  /** For the control's `aria-describedby`. */
  descriptionId?: string
  /** Attributes for the row itself: `hidden`, or a `data-` name a style rule shows it by. */
  row?: { hidden?: boolean; 'data-show'?: string }
  children: ReactNode
}) {
  return (
    <tr {...row}>
      <th scope="row">{htmlFor ? <label htmlFor={htmlFor}>{label}</label> : label}</th>
      <td>
        {children}
        {description && (
          <p className="description" id={descriptionId}>
            {description}
          </p>
        )}
      </td>
    </tr>
  )
}

/** The primary button under a form (`submit_button()`). */
export function SubmitButton({
  children = 'Save Changes',
  ...rest
}: { children?: ReactNode } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'>) {
  return (
    <p className="submit">
      <Button type="submit" variant="primary" {...rest}>
        {children}
      </Button>
    </p>
  )
}
