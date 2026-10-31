import { defineConfig, devices } from '@playwright/test'
import { SUPERVISOR } from './e2e/helpers'

const PORT = 3100
const { port: SUPERVISOR_PORT, token: SUPERVISOR_TOKEN } = SUPERVISOR

export default defineConfig({
  testDir: './e2e',
  // One server on one embedded database: run serially so tests don't race on order numbers.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // The admin's phone, tablet and touch layouts, in the engines those devices ship. They run
    // after the desktop project, which sets the site up.
    ...[
      'iPhone SE',
      'iPhone 15',
      'Pixel 7',
      'Pixel 7 landscape',
      'iPad Pro 11',
      'iPad Pro 11 landscape',
    ].map((device) => ({
      name: device,
      use: { ...devices[device] },
      testMatch: 'responsive.spec.ts',
      dependencies: ['chromium'],
    })),
  ],
  webServer: [
    // Stands in for `cms serve`, which the site reports updates through.
    {
      command: 'node e2e/fake-supervisor.mjs',
      url: `http://127.0.0.1:${SUPERVISOR_PORT}/health`,
      reuseExistingServer: false,
      env: {
        FAKE_SUPERVISOR_PORT: String(SUPERVISOR_PORT),
        CMS_SUPERVISOR_TOKEN: SUPERVISOR_TOKEN,
      },
    },
    {
      command: `pnpm build && pnpm seed --reset && pnpm start --port ${PORT}`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      env: {
        CMS_DATA_DIR: '.data/e2e',
        DATABASE_URL: '',
        STRIPE_SECRET_KEY: '',
        STRIPE_WEBHOOK_SECRET: '',
        CMS_SUPERVISOR_URL: `http://127.0.0.1:${SUPERVISOR_PORT}`,
        CMS_SUPERVISOR_TOKEN: SUPERVISOR_TOKEN,
      },
    },
  ],
})
