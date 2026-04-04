FROM postgres:16-alpine

ARG INIT_DIR=init-a
COPY ${INIT_DIR}/ /docker-entrypoint-initdb.d/
