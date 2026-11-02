import type { ContentTemplate, ContentView } from '@otw/sdk'

const VIEWS: readonly ContentView[] = ['single', 'archive', 'term']
const DEFAULT_PRIORITY = 10

type Component = ContentTemplate['component']

/**
 * Plugins' templates for their types' and taxonomies' pages. One per view and name wins: the
 * highest priority, and of equals the last registered, as the last `template_include` filter's
 * choice stands in WordPress.
 */
export class TemplateStore {
  readonly #templates = new Map<string, { component: Component; priority: number }>()
  readonly #assertOpen: (what: string) => void

  constructor(assertOpen: (what: string) => void) {
    this.#assertOpen = assertOpen
  }

  register(pluginId: string, template: ContentTemplate): void {
    this.#assertOpen(`template for "${String(template?.for)}"`)
    if (!VIEWS.includes(template.view)) {
      throw new Error(
        `Plugin "${pluginId}" gave a template an unknown view "${String(template.view)}"`,
      )
    }
    if (typeof template.for !== 'string' || typeof template.component !== 'function') {
      throw new Error(`Plugin "${pluginId}"'s template needs what it's for and a component`)
    }
    const priority = template.priority ?? DEFAULT_PRIORITY
    if (!Number.isFinite(priority)) throw new Error(`Template priority must be a finite number`)
    const key = `${template.view}:${template.for}`
    const current = this.#templates.get(key)
    if (!current || priority >= current.priority) {
      this.#templates.set(key, { component: template.component, priority })
    }
  }

  get(view: ContentView, name: string): Component | undefined {
    return this.#templates.get(`${view}:${name}`)?.component
  }
}
