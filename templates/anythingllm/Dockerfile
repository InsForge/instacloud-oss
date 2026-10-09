# Pinned by index digest, not by one of its children, so the arm64 half resolves too.
FROM docker.io/mintplexlabs/anythingllm:1.17.0@sha256:f26f30df46916b6e953e3a47ca98f48817726e3df635e62d4bfdd133292ecfff

# Two paths upstream writes to are not reachable from the manifest, and both of them are state.
#
#   /app/server/storage  the Prisma datasource URL is the literal `file:../storage/anythingllm.db`
#                        rather than env("DATABASE_URL"), so STORAGE_DIR moves the documents, the
#                        LanceDB index and the embedding models but never the database.
#   /app/server/.env     dumpENV() writes it with a path built from __dirname, and every provider
#                        choice and API key set in the UI goes through it. On a machine that
#                        idle-stops, losing it means the instance comes back with no LLM configured.
#
# A volume mounts at one place, so the entrypoint points both at /data instead. Upstream's
# entrypoint is left exactly as it is and exec'd at the end.
COPY entrypoint.sh /entrypoint.sh

# Root for the chmod only: the base image's USER is anythingllm (uid 1000), which is what the
# volume's ownership follows, and running as root here would write /data as root instead.
USER root
RUN chmod +x /entrypoint.sh
USER anythingllm

EXPOSE 3001
ENTRYPOINT ["/bin/bash", "/entrypoint.sh"]
