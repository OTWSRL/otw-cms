import type { SettingField, SettingsPageView } from '@otwdesign/core'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SettingsForm } from '../src/admin/settings-form'
import { conditionSelector, hiddenRule } from '../src/admin/settings-visibility'

const base = { source: 'default', locked: false } as const
const page = (fields: SettingField[], extra: Partial<SettingsPageView['sections'][number]> = {}) =>
  renderToStaticMarkup(
    <SettingsForm
      saveUrl="/api/p/core/actions/save-settings"
      view={{
        key: 'relay.settings',
        title: 'Relay',
        editable: true,
        sections: [{ key: 'relay.sending', title: 'Sending', fields, ...extra }],
      }}
    />,
  )

describe('the rule that hides a field', () => {
  it('reads a checkbox ticked or not, and a select’s chosen option', () => {
    expect(conditionSelector({ setting: 'relay.enabled', is: true } as never)).toBe(
      '[name="relay.enabled"]:checked',
    )
    expect(conditionSelector({ setting: 'relay.enabled', is: false } as never)).toBe(
      '[name="relay.enabled"]:not(:checked)',
    )
    expect(conditionSelector({ setting: 'relay.via', is: 'http' } as never)).toBe(
      '[name="relay.via"] option:is([value="http"]):checked',
    )
    expect(conditionSelector({ setting: 'relay.via', is: ['http', 'twilio'] } as never)).toBe(
      '[name="relay.via"] option:is([value="http"], [value="twilio"]):checked',
    )
  })

  it('hides unless any group holds, each with all its conditions', () => {
    const http = { setting: 'relay.via', is: 'http' } as never
    const on = { setting: 'relay.enabled', is: true } as never
    expect(hiddenRule('f', 'relay.url', { groups: [[http]], shown: false })).toBe(
      '#f:not(:is(:has([name="relay.via"] option:is([value="http"]):checked))) [data-show="relay.url"] { display: none; }',
    )
    expect(hiddenRule('f', 'x', { groups: [[http, on], [on]], shown: false })).toBe(
      '#f:not(:is(:has([name="relay.via"] option:is([value="http"]):checked):has([name="relay.enabled"]:checked), :has([name="relay.enabled"]:checked))) [data-show="x"] { display: none; }',
    )
    // Nothing on the page decides it: no rule, the row is simply hidden.
    expect(hiddenRule('f', 'x', { groups: [], shown: false })).toBeNull()
  })

  it('quotes a value that could break out of the rule', () => {
    expect(conditionSelector({ setting: 'a.b', is: 'x"] { } [y="' } as never)).toBe(
      '[name="a.b"] option:is([value="x\\"] { } [y=\\""]):checked',
    )
  })
})

describe('the settings form', () => {
  it('draws a checkbox for each role, the saved ones ticked', () => {
    const html = page([
      {
        ...base,
        key: 'relay.roles',
        type: 'roles',
        label: 'Who is told',
        value: ['editor'],
        options: [
          { value: 'administrator', label: 'Administrator' },
          { value: 'editor', label: 'Editor' },
        ],
      },
    ])
    expect(html).toContain('<legend class="screen-reader-text">Who is told</legend>')
    expect(html).toContain(
      '<input type="checkbox" name="relay.roles" value="administrator"/> Administrator',
    )
    expect(html).toContain(
      '<input type="checkbox" name="relay.roles" checked="" value="editor"/> Editor',
    )
  })

  it('draws a pairs field’s rows, one more to fill in, and a way to add and remove', () => {
    const html = page([
      {
        ...base,
        key: 'relay.headers',
        type: 'pairs',
        label: 'Headers',
        value: [{ name: 'X-Key', value: 'abc' }],
        columns: { name: 'Header', value: 'Value', maxRows: 5 },
      },
    ])
    expect(html.match(/name="relay\.headers\.name"/g)).toHaveLength(2)
    expect(html.match(/name="relay\.headers\.value"/g)).toHaveLength(2)
    expect(html).toContain('value="X-Key"')
    expect(html).toContain('>Header</th>')
    expect(html).toContain('Add Row')
    expect(html).toContain('aria-label="Remove X-Key"')
  })

  it('draws a multiline text setting as a box of lines', () => {
    const html = page([
      {
        ...base,
        key: 'relay.body',
        type: 'text',
        label: 'Body',
        multiline: true,
        value: 'a\nb\nc',
      },
    ])
    expect(html).toContain('<textarea id="setting-relay-body" name="relay.body"')
    expect(html).toContain('rows="4"')
    expect(html).toContain('a\nb\nc</textarea>')
  })

  it('marks what shows only sometimes, and writes the rules that hide it', () => {
    const html = page(
      [
        {
          ...base,
          key: 'relay.via',
          type: 'select',
          label: 'Send through',
          value: 'carrier',
          options: [
            { value: 'carrier', label: 'Carrier' },
            { value: 'http', label: 'HTTP' },
          ],
        },
        {
          ...base,
          key: 'relay.url',
          type: 'text',
          label: 'URL',
          visibility: { groups: [[{ setting: 'relay.via', is: 'http' } as never]], shown: false },
        },
        {
          ...base,
          key: 'relay.template',
          type: 'text',
          label: 'Template',
          value: 'kept',
          // Decided on another page, against it: hidden outright.
          visibility: { groups: [], shown: false },
        },
      ],
      {
        visibility: { groups: [[{ setting: 'relay.enabled', is: true } as never]], shown: true },
        link: { label: 'Send a test', url: '/admin/relay/test' },
      },
    )
    expect(html).toContain('<form id="settings-form-relay-settings"')
    expect(html).toContain('<tr data-show="relay.url">')
    expect(html).toContain(
      '<section aria-labelledby="settings-relay-sending" data-show="relay.sending">',
    )
    expect(html).toContain(
      '#settings-form-relay-settings:not(:is(:has([name="relay.via"] option:is([value="http"]):checked))) [data-show="relay.url"] { display: none; }',
    )
    // Hidden, and still in the form: saving keeps its value.
    expect(html).toContain('<tr hidden="">')
    expect(html).toContain('class="regular-text" name="relay.template" value="kept"')
    expect(html).toContain('<a class="button" href="/admin/relay/test">Send a test</a>')
  })

  it('writes no rules for a page where everything always shows', () => {
    const html = page([{ ...base, key: 'relay.url', type: 'text', label: 'URL' }])
    expect(html).not.toContain('<style')
    expect(html).not.toContain('data-show')
  })
})
