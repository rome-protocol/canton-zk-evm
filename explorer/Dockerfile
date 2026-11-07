# The explorer as one image: the server, the pages, and the Verify check built for WebAssembly. Build it from the repository root, with the
# two base images that PINS pins (explorer/run.sh does this):
#   docker build -f explorer/Dockerfile --build-arg EXPLORER_NODE_IMAGE=... --build-arg EXPLORER_RUST_IMAGE=... .
# The files sit in the image where they sit in the repository, so the server finds the recorded pins (prover/fixtures/session.txt) the same way.
ARG EXPLORER_NODE_IMAGE
ARG EXPLORER_RUST_IMAGE

# The Verify check: the sidecar's own block check, built with rust-toolchain.toml's toolchain. It builds from the lockfile, and fails if
# the lockfile would change.
FROM ${EXPLORER_RUST_IMAGE} AS wasm
WORKDIR /repo
COPY rust-toolchain.toml ./
COPY sidecar ./sidecar
COPY verifier ./verifier
COPY mpt ./mpt
COPY explorer/verify ./explorer/verify
RUN rustup target add wasm32-unknown-unknown && sh explorer/verify/build.sh

# The pages, from the lockfile, with the check's file put where the pages' build copies it from.
FROM ${EXPLORER_NODE_IMAGE} AS pages
WORKDIR /repo/explorer
COPY explorer/package.json explorer/package-lock.json ./
RUN npm ci --ignore-scripts
# The Bridge page pins the gateway's address (PINS), the hash of the vault's code and, for this deployment, the wrapped coin's address (BRIDGE_WTROME_ADDRESS, none when empty:
# the page then does not wrap) when it is built: explorer/bridge-pins.ts reads them from beside the explorer folder.
COPY PINS /repo/PINS
COPY gateway/Vault.bin-runtime /repo/gateway/Vault.bin-runtime
ARG BRIDGE_WTROME_ADDRESS=
COPY explorer/index.html explorer/tsconfig.json explorer/vite.config.ts explorer/bridge-pins.ts ./
COPY explorer/src ./src
COPY explorer/public ./public
COPY --from=wasm /repo/explorer/public/verify ./public/verify
RUN npm run build

FROM ${EXPLORER_NODE_IMAGE} AS run
ENV NODE_ENV=production
WORKDIR /repo/explorer
COPY explorer/package.json explorer/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY explorer/server ./server
COPY explorer/db ./db
COPY --from=pages /repo/explorer/dist ./dist
COPY prover/fixtures/session.txt /repo/prover/fixtures/session.txt
# The gateway's source, which the verifier role publishes as the gateway's verified source.
COPY gateway/Gateway.sol /repo/gateway/Gateway.sol
COPY LICENSE NOTICE /repo/
# The server listens on 127.0.0.1:8088 and reads reth and Canton on the machine's own ports, so it runs on the host's network
# (explorer/run.sh). It runs as an unprivileged user; run.sh gives it the caller's id, so that it can read the faucet's key.
USER node
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s CMD node -e "fetch('http://'+(process.env.EXPLORER_HOST||'127.0.0.1')+':'+(process.env.EXPLORER_PORT||'8088')+'/healthz').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/main.ts"]
