# EmoWave runs as a long-running Node container, not a serverless function:
# lib/renderReportPdf.ts launches a real headless Chromium through Puppeteer to
# print every report, and the extract routes write dumps to /app/extractions.
# Neither survives a serverless runtime, which is why this image exists.
#
# Pinned to bookworm rather than a floating tag: the Chromium runtime libraries
# below are named differently on trixie (libasound2 became libasound2t64), so a
# base-image bump would break the install silently.
FROM node:24-bookworm-slim

# Chromium's runtime dependencies. Puppeteer downloads the browser binary
# itself during `npm ci`, but the shared libraries it links against are not
# bundled with it — without these, launch() fails at runtime, not at build.
#
# unzip is not one of those libraries, and it is not optional either:
# @puppeteer/browsers shells out to the `unzip` binary to unpack Chrome's
# archive on Linux, and node:*-slim doesn't ship it. Without it `npm ci` dies
# in puppeteer's postinstall, at BUILD time, with "Puppeteer installation
# failed due to missing unzip tool".
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      unzip \
      fonts-liberation \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libexpat1 \
      libfontconfig1 \
      libgbm1 \
      libglib2.0-0 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libx11-6 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Keep Puppeteer's downloaded Chrome inside the app directory. The default is
# $HOME/.cache/puppeteer, which is easy to lose between build stages or when
# the container runs as a different user.
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer
ENV NEXT_TELEMETRY_DISABLED=1

# prisma/ is copied before `npm ci` because package.json's postinstall runs
# `prisma generate`, which needs schema.prisma to already be there.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

COPY . .

# NEXT_PUBLIC_* values are inlined into the browser bundle by `next build`, so
# they must be present HERE, at build time — setting them only at runtime
# leaves the client-side Supabase client with undefined credentials and every
# admin login fails. On DigitalOcean App Platform these two must be marked
# "Available at build time"; with `docker build`, pass them with --build-arg.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY

# Fail loudly HERE rather than silently at runtime. `next build` inlines every
# NEXT_PUBLIC_* value into the bundle, so an empty one is compiled in as
# `undefined` and the first request dies in middleware.ts with "Invalid
# supabaseUrl: Provided URL is malformed" — a 500 on every route, health checks
# included, from an image that built and booted perfectly. This turns that into
# an obvious build failure naming the variable.
RUN for v in NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY; do \
      eval "val=\$$v"; \
      if [ -z "$val" ]; then \
        echo "BUILD ABORTED: $v is empty at build time."; \
        echo "On App Platform, tick 'Available at build time' on that variable."; \
        exit 1; \
      fi; \
      echo "ok: $v is set (length $(printf %s "$val" | wc -c), begins $(printf %s "$val" | cut -c1-8))"; \
    done

RUN npm run build

ENV NODE_ENV=production
# App Platform routes to 8080 by default; `next start` honours $PORT.
ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
