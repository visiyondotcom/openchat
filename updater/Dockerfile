# Minimal image: Node for the status/trigger server, git + the docker CLI
# (with the compose plugin) so it can pull and rebuild the stack it's
# sitting next to. No app dependencies — server.js only uses Node's
# built-ins on purpose, to keep this image small and its attack surface
# tiny given the access it needs (docker socket + repo checkout).
FROM node:22-alpine

RUN apk add --no-cache git docker-cli docker-cli-compose

WORKDIR /app
COPY server.js .

EXPOSE 9000
CMD ["node", "server.js"]
