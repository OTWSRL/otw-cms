import type { AccountTemplateProps } from '@otw/sdk'
import Link from 'next/link'
import type { ReactNode } from 'react'

/** The one-time message after a form: read out as it appears. */
function Notice({ notice }: Pick<AccountTemplateProps, 'notice'>) {
  if (!notice) return null
  return (
    <p
      className={`account-notice account-notice-${notice.kind}`}
      role={notice.kind === 'error' ? 'alert' : 'status'}
    >
      {notice.message}
    </p>
  )
}

/** A form that posts to an account action. Plain HTML: it works before any JavaScript does. */
function Form({
  action,
  label,
  submit,
  children,
}: {
  action: string
  label: string
  submit: string
  children: ReactNode
}) {
  return (
    <form method="post" action={action} className="account-form" aria-label={label}>
      {children}
      <p>
        <button type="submit">{submit}</button>
      </p>
    </form>
  )
}

function Field({
  form,
  name,
  label,
  type = 'text',
  autoComplete,
  defaultValue,
  required = true,
  hint,
}: {
  /** Which form it's in, so two forms' fields of one name have ids of their own. */
  form: string
  name: string
  label: string
  type?: 'text' | 'email' | 'password'
  autoComplete: string
  defaultValue?: string
  required?: boolean
  hint?: string
}) {
  const id = `account-${form}-${name}`
  return (
    <p className="account-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={name}
        type={type}
        autoComplete={autoComplete}
        defaultValue={defaultValue}
        required={required}
        aria-describedby={hint ? `${id}-hint` : undefined}
        {...(type === 'password' && autoComplete === 'new-password' ? { minLength: 10 } : {})}
      />
      {hint && (
        <span className="account-hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
    </p>
  )
}

const EXPIRED = 'This link has expired or has already been used.'

/**
 * The account pages, as WooCommerce's My Account and `wp-login.php` show them: signing in (and
 * up, when the site allows it), asking for a reset link, setting a password from one, confirming
 * a new address, and the signed-in person's details. A server component with plain forms.
 */
export function AccountTemplate(props: AccountTemplateProps) {
  const { view, actions, paths, notice } = props
  if (view === 'sign-in') {
    return (
      <section className="account account-sign-in">
        <h1>Sign in</h1>
        <Notice notice={notice} />
        <Form action={actions.signIn} label="Sign in" submit="Sign in">
          {props.next && <input type="hidden" name="next" value={props.next} />}
          <Field
            form="sign-in"
            name="email"
            label="Email address"
            type="email"
            autoComplete="username"
          />
          <Field
            form="sign-in"
            name="password"
            label="Password"
            type="password"
            autoComplete="current-password"
          />
        </Form>
        <p>
          <a href={paths.lostPassword}>Lost your password?</a>
        </p>
        {props.canRegister && (
          <>
            <h2>Register</h2>
            <Form action={actions.register} label="Register" submit="Register">
              <Field
                form="register"
                name="name"
                label="Name"
                autoComplete="name"
                required={false}
              />
              <Field
                form="register"
                name="email"
                label="Email address"
                type="email"
                autoComplete="email"
              />
              <p className="account-hint">We’ll email you a link to set your password.</p>
            </Form>
          </>
        )}
      </section>
    )
  }
  if (view === 'lost-password') {
    return (
      <section className="account account-lost-password">
        <h1>Lost password</h1>
        <Notice notice={notice} />
        <p>Enter your email address, and we’ll email you a link to set a new password.</p>
        <Form action={actions.lostPassword} label="Lost password" submit="Get a new password">
          <Field
            form="lost-password"
            name="email"
            label="Email address"
            type="email"
            autoComplete="email"
          />
        </Form>
        <p>
          <a href={paths.account}>← Back to sign in</a>
        </p>
      </section>
    )
  }
  if (view === 'reset') {
    return (
      <section className="account account-reset">
        <h1>Set your password</h1>
        <Notice notice={notice} />
        {props.valid ? (
          <Form action={actions.reset} label="Set your password" submit="Set password">
            <input type="hidden" name="token" value={props.token ?? ''} />
            <Field
              form="reset"
              name="password"
              label="New password"
              type="password"
              autoComplete="new-password"
              hint="At least 10 characters. A few words make a strong one."
            />
          </Form>
        ) : (
          <p>
            {EXPIRED} <a href={paths.lostPassword}>Get a new link</a>.
          </p>
        )}
      </section>
    )
  }
  if (view === 'confirm-email') {
    return (
      <section className="account account-confirm-email">
        <h1>Confirm your email address</h1>
        <Notice notice={notice} />
        {props.valid ? (
          <Form action={actions.confirmEmail} label="Confirm your email address" submit="Confirm">
            <input type="hidden" name="token" value={props.token ?? ''} />
            <p>
              Use <strong>{props.newEmail}</strong> as your account’s email address?
            </p>
          </Form>
        ) : (
          <p>
            {EXPIRED} Change your address again from <a href={paths.account}>your account</a>.
          </p>
        )}
      </section>
    )
  }
  const user = props.user!
  return (
    <section className="account account-details">
      <h1>Your account</h1>
      <Notice notice={notice} />
      <p>
        Signed in as <strong>{user.name || user.email}</strong>.
        {props.canUseAdmin && (
          <>
            {' '}
            <Link href="/admin">Go to the admin</Link>.
          </>
        )}
      </p>
      <h2>Name</h2>
      <Form action={actions.name} label="Name" submit="Save name">
        <Field
          form="name"
          name="name"
          label="Name"
          autoComplete="name"
          defaultValue={user.name}
          required={false}
        />
      </Form>
      <h2>Email address</h2>
      <p>
        {user.email}
        {props.verified ? ' (confirmed)' : ''}
      </p>
      <Form action={actions.email} label="Change email address" submit="Send a confirmation link">
        <Field
          form="email"
          name="email"
          label="New email address"
          type="email"
          autoComplete="email"
        />
        <Field
          form="email"
          name="password"
          label="Current password"
          type="password"
          autoComplete="current-password"
        />
      </Form>
      <h2>Password</h2>
      <Form action={actions.password} label="Change password" submit="Change password">
        <Field
          form="password"
          name="current"
          label="Current password"
          type="password"
          autoComplete="current-password"
        />
        <Field
          form="password"
          name="password"
          label="New password"
          type="password"
          autoComplete="new-password"
          hint="At least 10 characters. Your other sessions will be signed out."
        />
      </Form>
      <form method="post" action={actions.signOut} className="account-sign-out">
        <button type="submit">Sign out</button>
      </form>
    </section>
  )
}
