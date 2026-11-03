import { ADMIN_ICON_NAMES } from '@otwdesign/sdk'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AdminIcon,
  Button,
  ButtonLink,
  FormButton,
  FormField,
  ListTable,
  Notice,
  Postbox,
  TableNav,
  Views,
} from '../src'
import { ICONS } from '../src/icon-paths'

const html = (element: ReactElement) => renderToStaticMarkup(element)

/** A fragment of HTML as a DOM, for queries rather than string matching. */
function dom(element: ReactElement): DocumentFragment {
  const template = document.createElement('template')
  template.innerHTML = html(element)
  return template.content
}

interface Row {
  id: string
  name: string
  price: string
}

const rows: Row[] = [
  { id: 'a', name: 'Apron', price: '$32.50' },
  { id: 'b', name: 'Mug', price: '$12.00' },
]

const table = (extra: Partial<Parameters<typeof ListTable<Row>>[0]> = {}) => (
  <ListTable<Row>
    caption="Products"
    rows={rows}
    rowKey={(row) => row.id}
    empty="No products found."
    columns={[
      { key: 'name', label: 'Name', render: (row) => <strong>{row.name}</strong> },
      { key: 'price', label: 'Price', numeric: true, render: (row) => row.price },
    ]}
    {...extra}
  />
)

describe('ListTable', () => {
  it('links sortable headers, marking how the list is sorted now', () => {
    const fragment = dom(
      table({
        columns: [
          {
            key: 'name',
            label: 'Name',
            sort: { url: '?orderby=name&order=desc', current: 'asc' },
            render: (row) => row.name,
          },
          {
            key: 'price',
            label: 'Price',
            sort: { url: '?orderby=price' },
            render: (row) => row.price,
          },
          { key: 'id', label: 'Id', render: (row) => row.id },
        ],
      }),
    )
    const [name, price, id] = [...fragment.querySelectorAll('thead th')]
    expect(name!.className).toBe('column-name column-primary sorted asc')
    expect(name!.getAttribute('aria-sort')).toBe('ascending')
    expect(name!.querySelector('a')?.getAttribute('href')).toBe('?orderby=name&order=desc')
    expect(price!.className).toBe('column-price sortable')
    expect(price!.hasAttribute('aria-sort')).toBe(false)
    expect(id!.querySelector('a')).toBeNull()
  })

  it('leaves the checkbox off rows the user may not select', () => {
    const fragment = dom(
      table({
        select: {
          name: 'ids',
          value: (row) => row.id,
          label: (row) => row.name,
          enabled: (row) => row.id === 'a',
        },
      }),
    )
    const boxes = [...fragment.querySelectorAll<HTMLInputElement>('tbody input[type=checkbox]')]
    expect(boxes.map((box) => box.value)).toEqual(['a'])
    expect(fragment.querySelectorAll('tbody th.check-column')).toHaveLength(2)
  })

  it('renders WordPress list table markup with a primary column', () => {
    const fragment = dom(
      table({
        rowActions: (row) => [
          <a key="edit" href={`/edit/${row.id}`}>
            Edit
          </a>,
          'View',
        ],
      }),
    )
    const tableElement = fragment.querySelector('table')!
    expect(tableElement.className).toBe('wp-list-table widefat striped')
    expect(fragment.querySelector('caption')?.textContent).toBe('Products')

    const headers = [...fragment.querySelectorAll('thead th')].map((th) => th.className)
    expect(headers).toEqual(['column-name column-primary', 'column-price num'])

    const [first] = fragment.querySelectorAll('tbody tr')
    const cells = first!.querySelectorAll('td')
    // Phones show the label before each value, from data-colname.
    expect([...cells].map((cell) => cell.dataset.colname)).toEqual(['Name', 'Price'])
    expect(cells[0]!.querySelector('.row-actions')?.textContent).toBe('Edit | View')
    expect(cells[0]!.querySelector('button.toggle-row')?.getAttribute('aria-expanded')).toBe(
      'false',
    )
    // Actions and the toggle belong to the primary column only.
    expect(cells[1]!.querySelector('.row-actions, .toggle-row')).toBeNull()
  })

  it('puts the row actions and toggle on the column marked primary', () => {
    const fragment = dom(
      <ListTable<Row>
        caption="Products"
        rows={rows}
        rowKey={(row) => row.id}
        rowActions={() => ['Edit']}
        empty="None"
        columns={[
          { key: 'price', label: 'Price', render: (row) => row.price },
          { key: 'name', label: 'Name', primary: true, render: (row) => row.name },
        ]}
      />,
    )
    const cells = fragment.querySelector('tbody tr')!.querySelectorAll('td')
    expect(cells[0]!.querySelector('.row-actions')).toBeNull()
    expect(cells[1]!.className).toBe('column-name column-primary')
    expect(cells[1]!.querySelector('.row-actions')?.textContent).toBe('Edit')
  })

  it('adds a labelled checkbox per row for bulk actions', () => {
    const fragment = dom(
      table({ select: { name: 'ids', value: (row) => row.id, label: (row) => row.name } }),
    )
    expect(fragment.querySelector('thead .check-column input')?.getAttribute('aria-label')).toBe(
      'Select all',
    )
    const boxes = [...fragment.querySelectorAll<HTMLInputElement>('tbody th.check-column input')]
    expect(boxes.map((box) => [box.name, box.value, box.getAttribute('aria-label')])).toEqual([
      ['ids', 'a', 'Select Apron'],
      ['ids', 'b', 'Select Mug'],
    ])
  })

  it('spans the empty message across every column, and can drop the stripes', () => {
    const fragment = dom(
      table({
        rows: [],
        striped: false,
        select: { name: 'ids', value: (row) => row.id, label: (row) => row.name },
      }),
    )
    expect(fragment.querySelector('table')!.className).toBe('wp-list-table widefat')
    const empty = fragment.querySelector('tr.no-items td')!
    expect(empty.getAttribute('colspan')).toBe('3')
    expect(empty.textContent).toBe('No products found.')
  })

  it('marks rows with the class it is given', () => {
    const fragment = dom(table({ rowClassName: (row) => (row.id === 'a' ? 'active' : 'inactive') }))
    expect([...fragment.querySelectorAll('tbody tr')].map((tr) => tr.className)).toEqual([
      'active',
      'inactive',
    ])
  })
})

describe('TableNav', () => {
  it('counts items and links the pages around the current one', () => {
    const fragment = dom(
      <TableNav
        total={60}
        noun={['order', 'orders']}
        page={1}
        pages={3}
        pageUrl={(page) => `/orders?page=${page}`}
      />,
    )
    expect(fragment.querySelector('.displaying-num')?.textContent).toBe('60 orders')
    expect(fragment.querySelector('.paging-input')?.textContent).toBe('1 of 3')
    // First and previous are unavailable on page one.
    expect(fragment.querySelectorAll('.tablenav-pages-navspan.disabled')).toHaveLength(2)
    expect([...fragment.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      '/orders?page=2',
      '/orders?page=3',
    ])
    expect(fragment.querySelector('.next-page')?.textContent).toBe('Next page›')
  })

  it('shows only the count on a single page, in the singular for one', () => {
    const fragment = dom(<TableNav total={1} noun={['item', 'items']} />)
    expect(fragment.querySelector('.displaying-num')?.textContent).toBe('1 item')
    expect(fragment.querySelector('.pagination-links')).toBeNull()
    expect(fragment.querySelector('.tablenav-pages')?.className).toBe('tablenav-pages one-page')
  })
})

describe('Views', () => {
  it('marks the current view and shows counts', () => {
    const fragment = dom(
      <Views
        label="Filter plugins"
        views={[
          { label: 'All', count: 3, href: '/p', current: true },
          { label: 'Active', count: 2, href: '/p?s=active' },
          { label: 'Recent', href: '/p?s=recent' },
        ]}
      />,
    )
    expect(fragment.querySelector('nav')?.getAttribute('aria-label')).toBe('Filter plugins')
    expect(fragment.querySelector('ul.subsubsub')?.textContent).toBe('All (3) |Active (2) |Recent')
    const current = fragment.querySelector('a.current')!
    expect(current.getAttribute('aria-current')).toBe('page')
    expect(current.textContent).toBe('All (3)')
  })
})

describe('Notice and Postbox', () => {
  it('wraps text in a paragraph and adds a dismiss button on request', () => {
    expect(html(<Notice type="error">Broken.</Notice>)).toBe(
      '<div class="notice notice-error"><p>Broken.</p></div>',
    )
    const fragment = dom(
      <Notice type="success" role="status" title="Saved" dismissible>
        <p>All good.</p>
      </Notice>,
    )
    const notice = fragment.querySelector('.notice')!
    expect(notice.className).toBe('notice notice-success is-dismissible')
    expect(notice.getAttribute('role')).toBe('status')
    expect([...notice.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      'Saved',
      'All good.',
    ])
    expect(notice.querySelector('button.notice-dismiss')?.textContent).toBe('Dismiss this notice.')
  })

  it('labels a postbox by its title', () => {
    const fragment = dom(
      <Postbox id="orders" title="Orders">
        <p>3 waiting</p>
      </Postbox>,
    )
    const box = fragment.querySelector('section.postbox')!
    expect(box.getAttribute('aria-labelledby')).toBe('orders-title')
    expect(box.querySelector('#orders-title')?.textContent).toBe('Orders')
    expect(box.querySelector('.inside')?.textContent).toBe('3 waiting')
  })
})

describe('forms and buttons', () => {
  it('labels a single control and describes it', () => {
    const fragment = dom(
      <table>
        <tbody>
          <FormField label="Title" htmlFor="title" description="Shown in tabs" descriptionId="d">
            <input id="title" />
          </FormField>
        </tbody>
      </table>,
    )
    expect(fragment.querySelector('th[scope="row"] label')?.getAttribute('for')).toBe('title')
    expect(fragment.querySelector('p.description#d')?.textContent).toBe('Shown in tabs')
  })

  it('uses WordPress button classes', () => {
    expect(html(<Button variant="primary">Save</Button>)).toBe(
      '<button type="button" class="button button-primary">Save</button>',
    )
    expect(html(<ButtonLink href="/new">Add</ButtonLink>)).toBe(
      '<a class="button" href="/new">Add</a>',
    )
    expect(html(<Button variant="delete">Remove</Button>)).toContain(
      'class="button-link button-link-delete"',
    )
  })

  it('posts hidden fields from a form button', () => {
    const fragment = dom(
      <FormButton action="/api/p/core/actions/x" fields={{ plugin: 'shop' }} variant="link">
        Activate
      </FormButton>,
    )
    const form = fragment.querySelector('form')!
    expect(form.getAttribute('method')).toBe('post')
    expect(form.getAttribute('action')).toBe('/api/p/core/actions/x')
    expect(form.querySelector('input[type="hidden"]')?.outerHTML).toBe(
      '<input type="hidden" name="plugin" value="shop">',
    )
    expect(form.querySelector('button')?.className).toBe('button-link')
  })
})

describe('AdminIcon', () => {
  it('draws every built-in icon', () => {
    for (const name of ADMIN_ICON_NAMES) {
      expect(ICONS[name].d, name).toMatch(/^M[\d .,A-Za-z-]+$/)
    }
    const svg = dom(<AdminIcon icon="cart" />).querySelector('svg')!
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.querySelector('path')?.getAttribute('d')).toBe(ICONS.cart.d)
  })

  it('tints a data URI icon with a mask in the text colour', () => {
    const icon = 'data:image/svg+xml;base64,PHN2Zy8+'
    const span = dom(<AdminIcon icon={icon} />).querySelector('span')!
    expect(span.getAttribute('style')).toContain(`url("${icon}")`)
    expect(span.getAttribute('style')).toContain('background:currentColor')
  })
})
