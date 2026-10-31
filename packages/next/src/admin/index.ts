/* The admin's route modules. `cms generate` writes the files in the site that re-export these. */
export { AdminForbidden, AdminNotFound } from './forbidden'
export { AdminRootLayout } from './root-layout'
export { AdminPage, generateAdminMetadata, type AdminRouteProps } from './router'
