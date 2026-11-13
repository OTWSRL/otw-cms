import type { SettingVisibility } from '@otwdesign/core'
import type { SettingCondition } from '@otwdesign/sdk'

// A settings field that shows only while another setting has a value is hidden by a style rule,
// not by script: `:has()` reads the form's own controls, so the field follows the form as it's
// changed, before any JavaScript has loaded and with none at all.

/**
 * A value as a CSS string. Quotes and backslashes are escaped, and so are `<` and line breaks,
 * as code points: nothing a setting's key or an option's value holds can end the string, the
 * rule, or the style element it's written in.
 */
const quote = (value: string) =>
  `"${value.replace(/["\\]/g, '\\$&').replace(/[<>\n\r\f]/g, (char) => `\\${char.codePointAt(0)!.toString(16)} `)}"`

/** What matches inside the form while one condition holds: the control, in the state it asks for. */
export function conditionSelector(condition: SettingCondition): string {
  const control = `[name=${quote(condition.setting)}]`
  if (typeof condition.is === 'boolean') {
    return condition.is ? `${control}:checked` : `${control}:not(:checked)`
  }
  const values = typeof condition.is === 'string' ? [condition.is] : condition.is
  return `${control} option:is(${values.map((value) => `[value=${quote(value)}]`).join(', ')}):checked`
}

/**
 * The rule that hides `[data-show="{target}"]` inside `#{form}` unless one of the groups holds,
 * each with all its conditions; `null` when there is nothing for a rule to follow.
 */
export function hiddenRule(
  form: string,
  target: string,
  visibility: SettingVisibility,
): string | null {
  if (visibility.groups.length === 0) return null
  const groups = visibility.groups.map((group) =>
    group.map((condition) => `:has(${conditionSelector(condition)})`).join(''),
  )
  return `#${form}:not(:is(${groups.join(', ')})) [data-show=${quote(target)}] { display: none; }`
}
