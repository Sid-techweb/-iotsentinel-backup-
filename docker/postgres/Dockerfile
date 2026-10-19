# PostgreSQL 16 + pgvector, built on the same Alpine image the project already used so that
# existing data volumes (and their text-sorting rules) stay valid.
FROM postgres:16-alpine AS build
ARG PGVECTOR_VERSION=0.8.1
RUN apk add --no-cache build-base git \
 && git clone --branch "v${PGVECTOR_VERSION}" --depth 1 https://github.com/pgvector/pgvector.git /tmp/pgvector \
 && cd /tmp/pgvector \
 && make OPTFLAGS="" with_llvm=no \
 && make install with_llvm=no

FROM postgres:16-alpine
COPY --from=build /usr/local/lib/postgresql/vector.so /usr/local/lib/postgresql/vector.so
COPY --from=build /usr/local/share/postgresql/extension/vector* /usr/local/share/postgresql/extension/
