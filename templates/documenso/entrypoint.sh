#!/bin/sh
# Two things upstream's image leaves to a human with a shell, done here so a deploy needs neither.
# Upstream's own docker/start.sh runs unchanged as the last line: it is what checks the
# certificate, runs `prisma migrate deploy` and starts the server.
set -eu

# ---- 1. the From name -------------------------------------------------------------------------
# Documenso's production compose marks this one `:?err`, so upstream treats an unset value as a
# misconfiguration rather than a default. It is a display name, not a credential, so the template
# supplies one and leaves the variable optional for anyone who wants their own.
NEXT_PRIVATE_SMTP_FROM_NAME="${NEXT_PRIVATE_SMTP_FROM_NAME:-Documenso}"
export NEXT_PRIVATE_SMTP_FROM_NAME

# ---- 2. the signing certificate ---------------------------------------------------------------
# Documenso signs a completed PDF with a PKCS#12 certificate and ships none. Without one the server
# still boots (start.sh prints a warning, /api/health reports `warning` and still answers 200) and
# then fails at the moment a document is sealed, which is the one thing the application exists to
# do. No manifest field can carry a .p12, so it is generated here, once, onto the volume.
#
# The export ciphers are not a style choice. @libpdf/core 0.5.2, which is what
# packages/signing/transports/local.ts hands the file to, implements exactly four PKCS#12 PBE
# algorithms, all of them the SHA1-era ones: 3DES (2- and 3-key) and RC2 (40- and 128-bit).
# OpenSSL 3 defaults to AES-256-CBC under PBES2 instead. Documenso's own example certificate
# (apps/remix/example/cert.p12) is pbeWithSHAAnd3-KeyTripleDES-CBC, and its self-hosting
# troubleshooting page prints these same three flags.
#
# The passphrase is empty, which is what createLocalSigner falls back to when
# NEXT_PRIVATE_SIGNING_PASSPHRASE is unset. The file is on the service's own volume, readable only
# by the uid the application runs as.
cert_path="${NEXT_PRIVATE_SIGNING_LOCAL_FILE_PATH:-/data/signing/cert.p12}"

if [ -n "${NEXT_PRIVATE_SIGNING_LOCAL_FILE_CONTENTS:-}" ]; then
  # An operator's own certificate, passed in base64. loadP12() prefers it over the path, so
  # generating anything here would only be a file nothing reads.
  echo "insta: signing with the certificate supplied in NEXT_PRIVATE_SIGNING_LOCAL_FILE_CONTENTS"
elif [ -s "${cert_path}" ]; then
  echo "insta: signing certificate already present at ${cert_path}"
else
  echo "insta: no signing certificate at ${cert_path}, generating a self-signed one"
  mkdir -p "$(dirname "${cert_path}")"
  work="$(mktemp -d)"

  # Ten years, because this certificate is the deployment's identity and an expired one makes
  # every later signature fail with nothing in the UI to explain it. getCertificateStatus() checks
  # the validity window, so /api/certificate-status is where an expiry would show up.
  openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -keyout "${work}/key.pem" -out "${work}/cert.pem" \
    -subj "/CN=Documenso Self Hosted/O=Documenso" 2>/dev/null

  # Written beside the final path and moved into place, so a container killed mid-write leaves no
  # truncated .p12 for the next boot to find and skip over.
  openssl pkcs12 -export \
    -inkey "${work}/key.pem" -in "${work}/cert.pem" \
    -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
    -name "Documenso" -passout pass: \
    -out "${cert_path}.partial"

  chmod 0600 "${cert_path}.partial"
  mv "${cert_path}.partial" "${cert_path}"
  rm -rf "${work}"

  echo "insta: generated ${cert_path}"
fi

# Upstream's own start script, unchanged, from the working directory it expects
# (/app/apps/remix, where ../../packages/prisma/schema.prisma resolves).
exec sh start.sh
