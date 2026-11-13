import { metaOptions } from '@otwdesign/core'
import type { AccountTemplateProps, UserMetaField } from '@otwdesign/sdk'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { Slot } from './slot'

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

/** A button that sends a sign-in code: a form, since a link mustn't send anything. */
function SendCode({ action, method, label }: { action: string; method: string; label: string }) {
  return (
    <form method="post" action={action} className="account-send-code">
      <input type="hidden" name="method" value={method} />
      <input type="hidden" name="screen" value="account" />
      <button type="submit">{label}</button>
    </form>
  )
}

/**
 * A field a plugin puts on the account page, named `meta.{key}` as the admin's are, and listed in
 * `userFields` so an unticked checkbox counts as false.
 */
function UserField({ field, value }: { field: UserMetaField; value: unknown }) {
  const { definition, key } = field
  const id = `account-details-${key.replace('.', '-')}`
  const name = `meta.${key}`
  const hint = definition.type === 'strings' ? 'One per line.' : definition.description
  const described = hint ? { 'aria-describedby': `${id}-hint` } : {}
  const text = typeof value === 'string' ? value : ''
  const options = metaOptions(definition)
  let input: ReactNode
  if (definition.type === 'boolean') {
    input = (
      <input id={id} name={name} type="checkbox" defaultChecked={value === true} {...described} />
    )
  } else if (definition.type === 'number') {
    input = (
      <input
        id={id}
        name={name}
        type="number"
        step={definition.integer ? 1 : 'any'}
        min={definition.min}
        max={definition.max}
        defaultValue={typeof value === 'number' ? value : ''}
        {...described}
      />
    )
  } else if (definition.type === 'string' && options.length > 0) {
    input = (
      <select id={id} name={name} defaultValue={text} {...described}>
        {!options.some((option) => option.value === text) && <option value="">—</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    )
  } else if (definition.type === 'string' && !definition.multiline) {
    input = (
      <input
        id={id}
        name={name}
        type="text"
        maxLength={definition.maxLength}
        defaultValue={text}
        {...described}
      />
    )
  } else {
    const shown =
      definition.type === 'strings'
        ? Array.isArray(value)
          ? value.join('\n')
          : ''
        : definition.type === 'json'
          ? value === undefined
            ? ''
            : JSON.stringify(value, null, 2)
          : text
    input = <textarea id={id} name={name} rows={4} defaultValue={shown} {...described} />
  }
  return (
    <p className={`account-field account-field-${definition.type}`}>
      <input type="hidden" name="userFields" value={key} />
      <label htmlFor={id}>{definition.label}</label>
      {input}
      {hint && (
        <span className="account-hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
    </p>
  )
}

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
  if (view === 'verify') {
    const step = props.signIn
    if (!step) {
      return (
        <section className="account account-verify">
          <h1>That sign-in has run out</h1>
          <Notice notice={notice} />
          <p>
            <a href={paths.account}>Sign in again</a> to get a new code.
          </p>
        </section>
      )
    }
    const { method, rememberDays } = step
    const others = step.methods.filter((other) => other.id !== method.id)
    return (
      <section className="account account-verify">
        <h1>Verify it’s you</h1>
        <Notice notice={notice} />
        <Form action={actions.verify} label="Verify it’s you" submit="Verify">
          <input type="hidden" name="method" value={method.id} />
          <p className="account-field">
            <label htmlFor="account-verify-code">Code</label>
            <input
              id="account-verify-code"
              name="code"
              inputMode={method.numeric ? 'numeric' : 'text'}
              autoComplete="one-time-code"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={64}
              aria-describedby="account-verify-code-hint"
              required
            />
            <span className="account-hint" id="account-verify-code-hint">
              {method.prompt}
            </span>
          </p>
          {rememberDays > 0 && (
            <p className="account-field account-field-boolean">
              <label>
                <input type="checkbox" name="remember" /> Don’t ask again on this device for{' '}
                {rememberDays} {rememberDays === 1 ? 'day' : 'days'}
              </label>
            </p>
          )}
        </Form>
        {(method.sends || others.length > 0) && (
          <ul className="account-verify-ways">
            {method.sends && (
              <li>
                <SendCode action={actions.sendCode} method={method.id} label="Send a new code" />
              </li>
            )}
            {others.map((other) => (
              <li key={other.id}>
                {other.sends ? (
                  <SendCode
                    action={actions.sendCode}
                    method={other.id}
                    label={`Use another way: ${other.label}`}
                  />
                ) : (
                  <a href={`${paths.verify}?method=${encodeURIComponent(other.id)}`}>
                    Use another way: {other.label}
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
        <p>
          <a href={paths.account}>← Back to sign in</a>
        </p>
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
      <h2>Your details</h2>
      <Form action={actions.name} label="Your details" submit="Save details">
        <Field
          form="name"
          name="name"
          label="Name"
          autoComplete="name"
          defaultValue={user.name}
          required={false}
        />
        {props.fields.map((field) => (
          <UserField
            key={field.key}
            field={field}
            value={(props.meta as Record<string, unknown>)[field.key]}
          />
        ))}
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
      <Slot name="account.sections" props={{ user }} />
      <form method="post" action={actions.signOut} className="account-sign-out">
        <button type="submit">Sign out</button>
      </form>
    </section>
  )
}
