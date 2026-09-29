# Capturekit CI image (M3 automation).
#
# Playwright's image already carries Node, system dependencies, and browsers,
# so the Dockerfile only layers capturekit itself on top. Pinned to the
# Playwright major that package.json depends on (1.63.x).
#
#   docker build -t capturekit .
#   docker run --rm -v "$PWD/captures:/app/captures" capturekit run http://host.docker.internal:3000
#
# In CI, prefer the official GitHub Action (action.yml); the image is for
# GitLab, Jenkins, and other runners.

FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY bin/ ./bin/
COPY src/ ./src/
COPY README.md LICENSE ./

# Browsers are baked into the base image; verify the binary resolves.
RUN node bin/capturekit.mjs doctor

ENTRYPOINT ["node", "bin/capturekit.mjs"]
CMD ["--help"]
