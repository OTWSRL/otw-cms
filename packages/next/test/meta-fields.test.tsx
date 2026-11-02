// @vitest-environment happy-dom
import type { MetaDefinition, MetaField } from '@otw/sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MetaFields } from '../src/admin/screens/meta-fields'

// Any definition's fields, before `types`, which every field here shares.
const field = (key: string, definition: Record<string, unknown>): MetaField => ({
  key,
  pluginId: 'lms',
  definition: { types: '*', ...definition } as MetaDefinition,
})

const fields = [
  field('lms.level', {
    label: 'Level',
    type: 'string',
    options: ['beginner', { value: 'advanced', label: 'Advanced' }],
    default: 'beginner',
  }),
  field('lms.hours', { label: 'Hours', type: 'number', integer: true, min: 1 }),
  field('lms.featured', { label: 'Featured', type: 'boolean' }),
  field('lms.skills', { label: 'Skills', type: 'strings', description: 'What it teaches.' }),
  field('lms.price', {
    label: 'Price',
    type: 'number',
    capability: 'core.manage_settings' as never,
  }),
]

function render(meta: Record<string, unknown>, editable = (f: MetaField) => f.key !== 'lms.price') {
  const template = document.createElement('template')
  template.innerHTML = renderToStaticMarkup(
    <MetaFields fields={fields} meta={meta as never} editable={editable} />,
  )
  return template.content
}

describe('MetaFields', () => {
  it("renders each field's input with its value, and names those the save may change", () => {
    const dom = render({
      'lms.level': 'advanced',
      'lms.hours': 3,
      'lms.featured': true,
      'lms.skills': ['a', 'b'],
    })
    const named = [...dom.querySelectorAll<HTMLInputElement>('input[name="metaFields"]')].map(
      (i) => i.value,
    )
    expect(named).toEqual(['lms.level', 'lms.hours', 'lms.featured', 'lms.skills'])
    expect(dom.querySelector<HTMLSelectElement>('select[name="meta.lms.level"]')?.innerHTML).toBe(
      '<option value="beginner">beginner</option><option value="advanced" selected="">Advanced</option>',
    )
    const hours = dom.querySelector<HTMLInputElement>('input[name="meta.lms.hours"]')!
    expect([hours.type, hours.value, hours.step, hours.min]).toEqual(['number', '3', '1', '1'])
    expect(dom.querySelector<HTMLInputElement>('input[name="meta.lms.featured"]')?.checked).toBe(
      true,
    )
    const skills = dom.querySelector<HTMLTextAreaElement>('textarea[name="meta.lms.skills"]')!
    expect(skills.value).toBe('a\nb')
    expect(dom.getElementById(skills.getAttribute('aria-describedby')!)?.textContent).toBe(
      'What it teaches. One per line.',
    )
  })

  it('shows defaults, and fields the user may not change disabled and unsent', () => {
    const dom = render({ 'lms.price': 30 })
    expect(dom.querySelector<HTMLSelectElement>('#meta-lms-level option[selected]')?.value).toBe(
      'beginner',
    )
    const price = dom.querySelector<HTMLInputElement>('#meta-lms-price')!
    expect([price.disabled, price.hasAttribute('name'), price.value]).toEqual([true, false, '30'])
    expect(dom.querySelector<HTMLInputElement>('input[name="meta.lms.hours"]')?.value).toBe('')
  })
})
