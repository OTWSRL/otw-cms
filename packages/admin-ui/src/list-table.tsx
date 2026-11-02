import type { ReactNode } from 'react'
import { cx } from './button'
import { RowToggle } from './row-toggle'
import { SelectAll } from './select-all'

/** A column of a `ListTable`: its header, and how a row renders in it. */
export interface Column<T> {
  key: string
  /** The header, and the label before the value when a phone expands the row. */
  label: string
  /**
   * Stays visible on phones and carries the row actions. Defaults to the first column; WordPress
   * calls it `column-primary`.
   */
  primary?: boolean
  /** Right-aligned, with tabular figures: prices, totals, counts. */
  numeric?: boolean
  /**
   * Makes the header a link that sorts by this column (`sortable`): `url` sorts it, and `current`
   * says how the list is sorted by it now, if it is.
   */
  sort?: { url: string; current?: 'asc' | 'desc' }
  render(row: T): ReactNode
}

/**
 * WordPress's list table (`WP_List_Table`): striped rows, actions under the primary column that
 * appear on hover or focus, and on phones a single column with a toggle for the rest.
 */
export function ListTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  rowActions,
  rowClassName,
  select,
  striped = true,
  className,
  empty,
}: {
  /** Read to screen readers before the table. */
  caption: string
  columns: readonly Column<T>[]
  rows: readonly T[]
  rowKey(row: T): string
  /** Links or buttons; separated by bars as in WordPress. */
  rowActions?(row: T): ReactNode[]
  /** `active` or `inactive` highlight a row, as on the plugins screen. */
  rowClassName?(row: T): string | undefined
  /**
   * A checkbox per row for bulk actions, named `name` and holding `value(row)`, on the rows
   * `enabled` allows. Put the table and the bulk controls in one form.
   */
  select?: {
    name: string
    value(row: T): string
    label(row: T): string
    enabled?(row: T): boolean
  }
  /** Alternate row shading. The plugins screen turns it off to show active rows instead. */
  striped?: boolean
  /** Extra classes on the table, such as `plugins`. */
  className?: string
  empty: ReactNode
}) {
  const primary = columns.find((column) => column.primary) ?? columns[0]
  const columnClass = (column: Column<T>) =>
    cx(`column-${column.key}`, column === primary && 'column-primary', column.numeric && 'num')
  const headerClass = (column: Column<T>) =>
    cx(
      columnClass(column),
      column.sort && (column.sort.current ? `sorted ${column.sort.current}` : 'sortable'),
    )

  return (
    <table className={cx('wp-list-table widefat', striped && 'striped', className)}>
      <caption className="screen-reader-text">{caption}</caption>
      <thead>
        <tr>
          {select && (
            <td className="check-column">
              <SelectAll name={select.name} />
            </td>
          )}
          {columns.map((column) => (
            <th
              key={column.key}
              scope="col"
              className={headerClass(column)}
              aria-sort={
                column.sort?.current === 'asc'
                  ? 'ascending'
                  : column.sort?.current === 'desc'
                    ? 'descending'
                    : undefined
              }
            >
              {column.sort ? (
                <a href={column.sort.url}>
                  <span>{column.label}</span>
                  <span className="sorting-indicators" aria-hidden="true">
                    <span className="sorting-indicator asc" />
                    <span className="sorting-indicator desc" />
                  </span>
                </a>
              ) : (
                column.label
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr className="no-items">
            <td colSpan={columns.length + (select ? 1 : 0)}>{empty}</td>
          </tr>
        ) : (
          rows.map((row) => {
            const actions = rowActions?.(row) ?? []
            return (
              <tr key={rowKey(row)} className={rowClassName?.(row)}>
                {select && (
                  <th scope="row" className="check-column">
                    {(select.enabled?.(row) ?? true) && (
                      <input
                        type="checkbox"
                        name={select.name}
                        value={select.value(row)}
                        aria-label={`Select ${select.label(row)}`}
                      />
                    )}
                  </th>
                )}
                {columns.map((column) => (
                  <td key={column.key} className={columnClass(column)} data-colname={column.label}>
                    {column.render(row)}
                    {column === primary && (
                      <>
                        {actions.length > 0 && <RowActions actions={actions} />}
                        {columns.length > 1 && <RowToggle />}
                      </>
                    )}
                  </td>
                ))}
              </tr>
            )
          })
        )}
      </tbody>
    </table>
  )
}

/** Links under a row's primary column, separated by bars: Edit | View | Trash. */
export function RowActions({ actions }: { actions: readonly ReactNode[] }) {
  return (
    <div className="row-actions">
      {actions.map((action, index) => (
        <span key={index}>
          {action}
          {index < actions.length - 1 && ' | '}
        </span>
      ))}
    </div>
  )
}

/** One of the filter links above a list, with its count. */
export interface View {
  label: string
  href: string
  count?: number
  current?: boolean
}

/** The filter links above a list: All (12) | Active (3) | … (`.subsubsub`). */
export function Views({ label, views }: { label: string; views: readonly View[] }) {
  return (
    <nav aria-label={label} className="views">
      <ul className="subsubsub">
        {views.map((view, index) => (
          <li key={view.href}>
            <a
              href={view.href}
              className={view.current ? 'current' : undefined}
              aria-current={view.current ? 'page' : undefined}
            >
              {view.label}
              {view.count !== undefined && (
                <>
                  {' '}
                  <span className="count">({view.count})</span>
                </>
              )}
            </a>
            {index < views.length - 1 && ' |'}
          </li>
        ))}
      </ul>
    </nav>
  )
}

/**
 * The bar above or below a list: bulk controls on the left, the count and page links on the
 * right (`.tablenav`).
 */
export function TableNav({
  total,
  noun,
  page = 1,
  pages = 1,
  pageUrl,
  children,
}: {
  total: number
  /** Singular and plural, as in `['item', 'items']`. */
  noun: readonly [string, string]
  page?: number
  pages?: number
  pageUrl?(page: number): string
  children?: ReactNode
}) {
  const link = (target: number, className: string, label: string, symbol: string) =>
    target === page || target < 1 || target > pages || !pageUrl ? (
      <span className="tablenav-pages-navspan button disabled" aria-hidden="true">
        {symbol}
      </span>
    ) : (
      <a className={cx(className, 'button')} href={pageUrl(target)}>
        <span className="screen-reader-text">{label}</span>
        <span aria-hidden="true">{symbol}</span>
      </a>
    )
  return (
    <div className="tablenav">
      {children && <div className="alignleft actions">{children}</div>}
      <div className={cx('tablenav-pages', pages <= 1 && 'one-page')}>
        <span className="displaying-num">
          {total} {total === 1 ? noun[0] : noun[1]}
        </span>
        {pages > 1 && (
          <span className="pagination-links">
            {link(1, 'first-page', 'First page', '«')}
            {link(page - 1, 'prev-page', 'Previous page', '‹')}
            <span className="paging-input">
              {page} of <span className="total-pages">{pages}</span>
            </span>
            {link(page + 1, 'next-page', 'Next page', '›')}
            {link(pages, 'last-page', 'Last page', '»')}
          </span>
        )}
      </div>
    </div>
  )
}
