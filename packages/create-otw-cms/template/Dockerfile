# For your own server: one container, the embedded database and the uploads in a volume,
# migrations at startup. The image holds Next.js's standalone server: only what the site runs on.
#
# With several containers, set DATABASE_URL and CMS_MIGRATIONS=deploy, and migrate once per
# release, before the new containers start, with the migrate target:
#   docker build --target migrate -t {{name}}-migrate .
#   docker run --rm --env-file .env {{name}}-migrate --no-backup
FROM node:24-slim AS build
WORKDIR /site
COPY . .
ENV CMS_STANDALONE=1
# public/ is optional in a site, but the last stage copies it.
RUN {{ci_install}} && {{run}} build && mkdir -p public

# `cms migrate`, with the whole install the command needs. Arguments after the image's name are
# its options.
FROM build AS migrate
ENTRYPOINT {{docker_migrate}}

FROM node:24-slim
WORKDIR /site
# HOSTNAME: Docker sets it to the container's id, which the server would listen on alone.
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 CMS_DATA_DIR=/data/pglite CMS_UPLOADS_DIR=/data/uploads
COPY --from=build /site/.next/standalone ./
COPY --from=build /site/.next/static ./.next/static
COPY --from=build /site/public ./public
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
