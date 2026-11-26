import { ListTable, Postbox, Tabs } from '@otwdesign/admin-ui'
import { defineAdmin } from '@otwdesign/sdk'
import library, { BOOKS, LOANS } from './index'

// The Library's admin: a section of two screens, Settings › Library, and a dashboard widget.
export default defineAdmin(library, (cms) => {
  // Each screen also has tabs to the other, as a plugin with one menu link would.
  const tabs = (current: 'loans' | 'books') => (
    <Tabs
      label="Library"
      tabs={[
        { label: 'Loans', href: cms.admin.url('library.loans'), current: current === 'loans' },
        { label: 'Books', href: cms.admin.url('library.books'), current: current === 'books' },
      ]}
    />
  )

  cms.admin.page({
    name: 'loans',
    path: '/loans',
    title: 'Loans',
    capability: 'library.manage_loans',
    menu: { label: 'Loans', order: 10 },
    component: () => (
      <>
        {tabs('loans')}
        <ListTable
          caption="Loans"
          rows={LOANS}
          rowKey={(loan) => loan.id}
          empty="No books on loan."
          columns={[
            {
              key: 'loan',
              label: 'Loan',
              render: (loan) => (
                <strong>
                  <a href={cms.admin.url('library.books')}>{loan.id}</a>
                </strong>
              ),
            },
            { key: 'book', label: 'Book', render: (loan) => loan.book },
            { key: 'borrower', label: 'Borrower', render: (loan) => loan.borrower },
            { key: 'due', label: 'Due', render: (loan) => loan.due },
          ]}
        />
      </>
    ),
  })

  cms.admin.page({
    name: 'books',
    path: '/books',
    title: 'Books',
    capability: 'library.manage_loans',
    menu: { label: 'Books', order: 20 },
    component: () => (
      <>
        {tabs('books')}
        <ListTable
          caption="Books"
          rows={BOOKS}
          rowKey={(book) => book.slug}
          empty="No books."
          columns={[
            { key: 'title', label: 'Title', render: (book) => <strong>{book.title}</strong> },
            { key: 'author', label: 'Author', render: (book) => book.author },
          ]}
        />
      </>
    ),
  })

  // Settings › Library, which Courier adds its section to.
  cms.admin.settingsPage({
    name: 'settings',
    path: '/settings',
    title: 'Library settings',
    capability: 'library.manage_settings',
    menu: { label: 'Library' },
  })
  cms.admin.settingsSection({
    name: 'reading-room',
    page: 'library.settings',
    title: 'Reading room',
    fields: ['library.open'],
  })
  cms.admin.settingsSection({
    name: 'storage',
    page: 'library.settings',
    title: 'Storage',
    order: 30,
    fields: ['library.test_bucket'],
  })
  cms.admin.settingsSection({
    name: 'notices',
    page: 'library.settings',
    title: 'Overdue notices',
    order: 20,
    fields: [
      'library.notify_roles',
      'library.notify_via',
      'library.notify_url',
      'library.notify_auth',
      'library.notify_headers',
      'library.notify_body',
    ],
    link: { label: 'See the books', url: cms.admin.url('/books') },
  })

  cms.slots.fill('admin.dashboard', {
    component: ({ user }) =>
      cms.auth.can(user, 'library.manage_loans') ? (
        <Postbox id="library-widget" title="Loans">
          <p>
            <a href={cms.admin.url('library.loans')}>{LOANS.length} books on loan</a>
          </p>
        </Postbox>
      ) : null,
  })
})
