---
'@otwdesign/sdk': minor
'@otwdesign/core': minor
'@otwdesign/next': minor
---

A plugin can add a step between a correct password and being signed in, as two-factor plugins
do, with `cms.auth.signInStep()`. Core holds the sign-in for ten minutes, shows the screen that
asks for the code (in the admin's sign-in frame, and as the account pages' new `verify` view),
counts wrong codes (five in fifteen minutes end it), and can remember a browser; the plugin says
which ways a person has, sends codes and checks them. A password set from an emailed link goes
through the step too. Without such a plugin, signing in is as before, with no added query.

Also new: `cms.auth.checkPassword()`, and the `admin.profile` and `admin.user` slots, for a
plugin's sections on the Profile and Edit User screens.

A site with its own account template shows the new `verify` view only once that template
handles it: `props.signIn`, `actions.verify` and `actions.sendCode`.
