---
'@otwdesign/sdk': minor
'@otwdesign/core': minor
'@otwdesign/next': minor
'create-otw-cms': minor
---

Sign-in providers: a plugin can add a way to sign in at another service, such as "Continue with
Google", with `cms.auth.signInProvider()`.

- Core shows the provider's button on the admin's sign-in page and on the account page
  (`providers` in the account template's props), and owns the two addresses a sign-in leaves by
  and comes back to. The state that ties the way back to the browser that left, the account an
  identity signs in to, and the session are core's; the provider only builds the address to send
  the person to, and reads who came back.
- A person is found by the provider's own id for them (`cms_identities`), never by address once
  they're linked. An address joins the account that already has it only when the provider is the
  authority for the address; someone without an account gets one when the provider names a role
  for new people, on an address the provider verified.
- A sign-in step (two-step sign-in) still asks for its code afterwards.
- `cms.auth.linkIdentity()` and `unlinkIdentity()` let a plugin link a signed-in person's id at
  its provider by hand. Deleting a plugin's data removes its identities.
- With no provider, the sign-in pages are as they were and run no extra query.
