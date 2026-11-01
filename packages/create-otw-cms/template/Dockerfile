# For your own server: one container, the embedded database in a volume, migrations at startup.
# With several containers, set DATABASE_URL and CMS_MIGRATIONS=deploy, and run `cms migrate` once
# per release before the new containers start.
FROM node:24-slim AS build
WORKDIR /site
COPY . .
RUN {{ci_install}} && {{run}} build

FROM node:24-slim
WORKDIR /site
{{docker_runtime}}
ENV NODE_ENV=production CMS_DATA_DIR=/data/pglite
COPY --from=build /site /site
VOLUME /data
EXPOSE 3000
CMD {{docker_start}}
