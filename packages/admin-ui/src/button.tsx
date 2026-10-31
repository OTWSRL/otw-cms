import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react'

/** WordPress's button styles: `button-primary`, `button` and the link-styled `button-link`. */
export type ButtonVariant = 'primary' | 'secondary' | 'link' | 'delete'

export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ')
}

export function buttonClass(variant: ButtonVariant = 'secondary', small = false): string {
  return cx(
    variant === 'primary' && 'button button-primary',
    variant === 'secondary' && 'button',
    variant === 'link' && 'button-link',
    variant === 'delete' && 'button-link button-link-delete',
    small && 'button-small',
  )
}

interface Styled {
  variant?: ButtonVariant
  small?: boolean
}

export function Button({
  variant,
  small,
  className,
  type = 'button',
  ...rest
}: Styled & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={cx(buttonClass(variant, small), className)} {...rest} />
}

export function ButtonLink({
  variant,
  small,
  className,
  ...rest
}: Styled & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a className={cx(buttonClass(variant, small), className)} {...rest} />
}

/**
 * A button that posts to an admin action, for row actions and screen actions that change data.
 * Admin actions only take POST, so these are forms rather than links (WordPress uses nonced GETs).
 */
export function FormButton({
  action,
  fields = {},
  variant,
  small,
  className,
  children,
  ...rest
}: {
  action: string
  fields?: Readonly<Record<string, string>>
  children: ReactNode
} & Styled &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'formAction'>) {
  return (
    <form method="post" action={action} className={cx('inline-form', className)}>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Button type="submit" variant={variant} small={small} {...rest}>
        {children}
      </Button>
    </form>
  )
}
