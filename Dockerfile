FROM node:24-slim

# git needed for mind git init + variants; procps/lsof for process management
RUN apt-get update && apt-get install -y --no-install-recommends git procps lsof ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system user.name "Volute" \
    && git config --system user.email "volute@localhost"

WORKDIR /opt/volute
COPY package*.json ./
RUN npm ci --production --ignore-scripts
COPY dist/ dist/
COPY drizzle/ drizzle/
COPY templates/ templates/
COPY skills/ skills/
COPY packages/extensions/notes/dist/ui/ packages/extensions/notes/dist/ui/
COPY packages/extensions/notes/skills/ packages/extensions/notes/skills/
COPY packages/extensions/pages/dist/ui/ packages/extensions/pages/dist/ui/
COPY packages/extensions/pages/skills/ packages/extensions/pages/skills/

# Make volute CLI available in PATH for minds and operators
RUN ln -s /opt/volute/dist/cli.js /usr/local/bin/volute

ENV VOLUTE_HOME=/data
ENV VOLUTE_MINDS_DIR=/minds
ENV VOLUTE_ISOLATION=user
EXPOSE 1618
VOLUME /data
VOLUME /minds

COPY docker/entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/daemon.js", "--host", "0.0.0.0", "--foreground"]
