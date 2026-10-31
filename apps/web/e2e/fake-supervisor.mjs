// Stands in for `cms serve`'s control port in the e2e suite, so the Updates screen can be
// driven without building releases. Same routes and token check as the real one.
import { createServer } from 'node:http'

const PORT = Number(process.env.FAKE_SUPERVISOR_PORT ?? 3199)
const TOKEN = process.env.CMS_SUPERVISOR_TOKEN ?? 'e2e-supervisor-token'
const UPDATE_STEPS = [
  'Check versions',
  'Build the new release',
  'Back up and migrate',
  'Start the new release',
  'Switch',
  'Finish',
]

const release = (id, version, status) => ({
  id,
  createdAt: `2026-10-${id === 'r1' ? '30' : '31'}T09:00:00.000Z`,
  versions: { '@cms/next': version, '@cms/plugin-commerce': '0.1.0' },
  status,
})

const state = {
  autoUpdate: 'off',
  releases: [release('r1', '0.1.0', 'previous'), release('r2', '0.1.0', 'live')],
  lastCheck: {
    at: '2026-11-01T06:00:00.000Z',
    core: { from: '0.1.0', to: '0.1.3' },
    plugins: [
      {
        name: '@cms/plugin-commerce',
        from: '0.1.0',
        to: '0.1.5',
        latest: '1.0.0',
        compatible: 'yes',
        note: '@cms/plugin-commerce-stripe 0.1.0 needs @cms/plugin-commerce ^0.1.0',
      },
      {
        name: '@cms/plugin-commerce-stripe',
        from: '0.1.0',
        to: null,
        latest: null,
        compatible: 'yes',
      },
    ],
    warnings: [],
    blockers: [],
  },
  job: null,
  requests: [],
}

/** Each status read moves a running job one step on, so the screen's progress can be watched. */
function advance() {
  const job = state.job
  if (!job || job.status !== 'running') return
  const next = job.steps.find((step) => step.status !== 'done')
  if (next.status === 'running') next.status = 'done'
  const pending = job.steps.find((step) => step.status === 'pending')
  if (pending) pending.status = 'running'
  if (job.steps.every((step) => step.status === 'done')) {
    job.status = 'succeeded'
    job.summary = job.kind === 'rollback' ? 'Rolled back.' : `Updated: ${job.describe}.`
    job.finishedAt = new Date().toISOString()
  }
}

function startJob(kind, steps, describe) {
  if (state.job?.status === 'running')
    return [409, { error: 'An update is already running. Wait for it to finish.' }]
  state.job = {
    id: `${kind}-1`,
    kind,
    status: 'running',
    startedAt: new Date().toISOString(),
    steps: steps.map((name, index) => ({ name, status: index === 0 ? 'running' : 'pending' })),
    log: ['== Check versions'],
    describe,
  }
  return null
}

const routes = {
  'GET /status': () => {
    advance()
    const { job } = state
    return [
      200,
      {
        channel: 'serve',
        database: 'embedded',
        current: state.releases.find((r) => r.status === 'live'),
        releases: state.releases,
        autoUpdate: state.autoUpdate,
        lastCheck: state.lastCheck,
        job: job && { ...job, describe: undefined },
      },
    ]
  },
  'POST /check': () => {
    state.lastCheck.at = new Date().toISOString()
    return [200, { notice: '1 update(s) available.' }]
  },
  'POST /update': (body) => {
    state.requests.push(body)
    const names = body.packages?.length ? body.packages.join(', ') : 'everything'
    return (
      startJob('update', UPDATE_STEPS, names) ?? [
        200,
        { notice: 'Updating. This page shows the progress.' },
      ]
    )
  },
  'POST /rollback': (body) => {
    if (body.release !== 'r1')
      return [404, { error: 'There is no earlier release with that id to go back to.' }]
    return (
      startJob('rollback', ['Start the previous release', 'Switch', 'Finish'], '') ?? [
        200,
        { notice: 'Going back to the release from 2026-10-30 09:00.' },
      ]
    )
  },
  'PUT /auto-update': (body) => {
    state.autoUpdate = body.mode
    return [
      200,
      {
        notice:
          body.mode === 'patch'
            ? 'Patch releases of core and plugins will be installed automatically.'
            : 'Automatic updates are off.',
      },
    ]
  },
  // For the tests: what the admin asked for.
  'GET /requests': () => [200, state.requests],
}

createServer((request, response) => {
  if (request.url === '/health') return response.end('ok')
  if (request.headers.authorization !== `Bearer ${TOKEN}`) {
    return response.writeHead(401).end('{"error":"Unauthorized"}')
  }
  let body = ''
  request.on('data', (chunk) => (body += chunk))
  request.on('end', () => {
    const route = routes[`${request.method} ${request.url}`]
    const [status, payload] = route
      ? route(body ? JSON.parse(body) : {})
      : [404, { error: 'Not found' }]
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
  })
}).listen(PORT, '127.0.0.1')
