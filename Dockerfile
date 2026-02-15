FROM node:22-slim

# git needed for agent git init + variants
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system user.name "Volute" \
    && git config --system user.email "volute@localhost"

WORKDIR /opt/volute
COPY package*.json ./
RUN npm ci --production --ignore-scripts
COPY dist/ dist/
COPY drizzle/ drizzle/
COPY templates/ templates/

ENV VOLUTE_HOME=/data
ENV VOLUTE_AGENTS_DIR=/agents
ENV VOLUTE_ISOLATION=user
EXPOSE 4200
VOLUME /data
VOLUME /agents

# Root inside container to manage agent users — isolated from host
ENTRYPOINT ["node", "dist/daemon.js", "--host", "0.0.0.0", "--foreground"]
