FROM registry.access.redhat.com/ubi9/nodejs-20
WORKDIR /opt/app-root/src
COPY --chown=1001:0 server.mjs ./server.mjs
COPY --chown=1001:0 public ./public
USER 1001
ENV PORT=8080
EXPOSE 8080
CMD ["node","server.mjs"]
