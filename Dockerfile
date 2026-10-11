FROM node:22-alpine
WORKDIR /app
COPY app/ /app/
ENV PORT=8780 DATA_DIR=/data
VOLUME ["/data"]
HEALTHCHECK --interval=60s --timeout=5s --start-period=15s \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/cameras" || exit 1
CMD ["node", "server.js"]
