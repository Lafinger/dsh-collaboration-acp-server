FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN apt-get update -o Acquire::Retries=3 \
    && apt-get install -y --no-install-recommends -o Acquire::Retries=3 ca-certificates \
    && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update -o Acquire::Retries=3 \
    && apt-get install -y --no-install-recommends -o Acquire::Retries=3 openssh-server git gosu procps \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@11.7.0 \
    && groupadd --gid 1100 collaboration-members \
    && groupadd --gid 1101 dshsvc && useradd --uid 1101 --gid 1101 --create-home --shell /bin/sh dshsvc \
    && groupadd --gid 1102 alice && useradd --uid 1102 --gid 1102 --create-home --shell /bin/sh alice \
    && groupadd --gid 1103 bob && useradd --uid 1103 --gid 1103 --create-home --shell /bin/sh bob \
    && usermod -a -G collaboration-members dshsvc \
    && usermod -a -G collaboration-members alice \
    && usermod -a -G collaboration-members bob \
    && passwd -d alice && passwd -d bob
WORKDIR /opt/collaboration
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts --store-dir /opt/pnpm-store \
    && rm -rf /opt/pnpm-store \
    && chmod -R go-w /opt/collaboration
COPY host-profile.json /opt/collaboration/host-profile.json
COPY profile.patch.yml /opt/collaboration/profile.patch.yml
COPY entrypoint.sh initialize.mjs health.mjs acceptance-policy.mjs mount-server.mjs host-codego.mjs inspect-state.mjs switch-mode.mjs permissions-check.mjs ssh-policy-check.mjs verify-state-budget.mjs snapshot-state.mjs reset-state.mjs verify-empty-state.mjs /opt/collaboration/
COPY sshd_config /etc/ssh/sshd_config
RUN for key in /etc/ssh/ssh_host_rsa_key /etc/ssh/ssh_host_rsa_key.pub /etc/ssh/ssh_host_ecdsa_key /etc/ssh/ssh_host_ecdsa_key.pub /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub; do test "$(readlink -f "$key")" = "$key" && rm -f "$key" || exit 1; done \
    && chmod 0755 /opt/collaboration/entrypoint.sh \
    && chmod go-w /opt/collaboration/*.mjs /opt/collaboration/*.json /opt/collaboration/*.yml /etc/ssh/sshd_config
ENV DSH_HOME=/srv/collaboration/dsh-home DSH_TELEMETRY_DISABLED=1
EXPOSE 22 23 24
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 CMD ["node", "/opt/collaboration/health.mjs"]
ENTRYPOINT ["/opt/collaboration/entrypoint.sh"]
