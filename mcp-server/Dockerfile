FROM registry.access.redhat.com/ubi9/nodejs-20
WORKDIR /opt/app-root/src
COPY --chown=1001:0 server.mjs ./server.mjs
USER 1001
ENV PORT=8081
EXPOSE 8081
CMD ["node","server.mjs"]
