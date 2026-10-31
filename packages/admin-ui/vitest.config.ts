import { defineProject } from 'vitest/config'

export default defineProject({
  // The components render markup; tests read it back through a DOM.
  test: { environment: 'happy-dom' },
})
