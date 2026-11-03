import { FormButton, FormField, FormTable, SubmitButton } from '@otwdesign/admin-ui'
import { inSentence, type Kernel } from '@otwdesign/core'
import type { SearchParams, Taxonomy, Term, User } from '@otwdesign/sdk'
import { AdminScreen } from '../screen'
import { ParentSelect, parentTerms } from './content-terms'

/** term.php: one term's name, slug, parent and description, and Delete unless it's the default. */
export async function ContentTermScreen({
  kernel,
  user,
  taxonomy,
  term,
  searchParams,
}: {
  kernel: Kernel
  user: User
  taxonomy: Taxonomy
  term: Term
  searchParams: SearchParams
}) {
  const singular = taxonomy.labels.singular
  const parents = taxonomy.hierarchical ? await parentTerms(kernel, taxonomy, term) : []
  return (
    <AdminScreen title={`Edit ${singular}`} flash={kernel.readFlash(searchParams.flash)}>
      <p>
        <a href={taxonomy.adminPath!}>← Go to {taxonomy.labels.plural}</a>
      </p>
      <form method="post" action={kernel.actionUrl('core', 'update-term')}>
        <input type="hidden" name="id" value={term.id} />
        <FormTable>
          <FormField label="Name" htmlFor="term-name">
            <input
              type="text"
              id="term-name"
              name="name"
              required
              maxLength={200}
              defaultValue={term.name}
              className="regular-text"
            />
          </FormField>
          <FormField
            label="Slug"
            htmlFor="term-slug"
            description="The address-friendly version of the name."
          >
            <input
              type="text"
              id="term-slug"
              name="slug"
              maxLength={200}
              defaultValue={term.slug}
              className="regular-text"
            />
          </FormField>
          {taxonomy.hierarchical && (
            <FormField label={`Parent ${singular}`} htmlFor="term-parent">
              <ParentSelect choices={parents} value={term.parentId ?? ''} />
            </FormField>
          )}
          <FormField label="Description" htmlFor="term-description">
            <textarea
              id="term-description"
              name="description"
              rows={5}
              maxLength={2000}
              defaultValue={term.description}
              className="large-text"
            />
          </FormField>
        </FormTable>
        <SubmitButton>Update</SubmitButton>
      </form>
      {kernel.can(user, taxonomy.capabilities.deleteTerm, term) && (
        <FormButton
          action={kernel.actionUrl('core', 'delete-term')}
          fields={{ id: term.id, redirect: taxonomy.adminPath! }}
          variant="delete"
        >
          Delete this {inSentence(singular)}
        </FormButton>
      )}
    </AdminScreen>
  )
}
