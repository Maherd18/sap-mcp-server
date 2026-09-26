# sap-mcp-server
#
# No npm dependencies and no build step: the image contains Node.js and the
# source only. The server speaks MCP over stdio, so always run it with -i:
#
#   docker run -i --rm --env-file .env -v sap-mcp-audit:/data ghcr.io/maherd18/sap-mcp-server
#
# Credentials are passed at runtime via --env-file or -e and are never baked
# into the image.

FROM node:22-alpine

LABEL org.opencontainers.image.title="sap-mcp-server" \
      org.opencontainers.image.description="MCP server with policy-controlled access to SAP ABAP development objects via ADT" \
      org.opencontainers.image.source="https://github.com/Maherd18/sap-mcp-server" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY config ./config
COPY scripts ./scripts

# Audit log goes to a volume so it survives the container.
# Custom policy: -v ./policy.json:/app/config/policy.json:ro
ENV NODE_ENV=production \
    SAP_MCP_AUDIT_FILE=/data/audit.jsonl

RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node

# Default: MCP server. Helper scripts can be run as the command, e.g.
#   docker run --rm --env-file .env ghcr.io/maherd18/sap-mcp-server scripts/check-connection.mjs
ENTRYPOINT ["node"]
CMD ["src/server.mjs"]
