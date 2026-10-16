# Documenso

Self-hosted document signing with a real PDF signature.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/documenso)

## Overview

[Documenso](https://github.com/documenso/documenso) is an open-source alternative to DocuSign. You
upload a PDF, drop signature, date, text and checkbox fields onto it, name the people who have to
fill them in, and send it. Each recipient gets a link, signs in the browser, and when the last one
is done Documenso seals the PDF with a cryptographic signature and mails everyone the finished
file along with an audit trail of who did what and when.

This template runs the official `documenso/documenso` image. The overlay image it builds adds one
shell script and changes nothing about the application: upstream's Remix build, its Prisma
migrations and its server are all untouched, and upstream's own `docker/start.sh` runs as the last
line of the entrypoint. The two steps in front of it are:

- **It generates the signing certificate.** Documenso signs a sealed PDF with a PKCS#12
  certificate and ships none, so out of the box every document fails at the moment it completes.
  No manifest field can carry a `.p12`, so the entrypoint makes a self-signed one on first boot and
  keeps it on the volume. It is exported with the SHA1-era PKCS#12 ciphers rather than OpenSSL 3's
  defaults, because `@libpdf/core`, the library Documenso parses the file with, implements only
  those four. Bring your own certificate with `NEXT_PRIVATE_SIGNING_LOCAL_FILE_CONTENTS` and the
  entrypoint generates nothing.
- **It defaults the From name** to `Documenso` when you have not set one, which upstream's own
  compose file treats as a required value.

Documents, fields, accounts and the audit trail live in the managed Postgres service the template
provisions alongside it. Uploaded PDFs do too: `NEXT_PUBLIC_UPLOAD_TRANSPORT` is `database`, which
is upstream's default and the one that needs no object store. The volume holds only the signing
certificate.

## What you get by hosting it

- An HTTPS URL for the whole of Documenso: the dashboard, the signing pages your recipients open,
  the embedding routes and the v2 API under `/api/v2`.
- A managed Postgres database, provisioned and wired in by the template. Prisma's migrations run on
  every boot, so updating this template migrates the schema on the way up.
- A working signing certificate from the first boot, kept on the volume across restarts.
- Signed PDFs and the documents behind them on infrastructure you control, which is the usual
  reason to self-host this rather than send contracts through someone else's service.
- The machine idle-stops and wakes on the next request. Documenso's default jobs provider is
  `local`, where a background job is triggered by the request that created it, so there is no
  scheduler that needs the machine kept warm.

## What you need before deploying

- **An SMTP server you can send through**, and an address you are allowed to send from. This is not
  optional polish: signing up does not sign you in, it mails a confirmation link, and Documenso
  refuses to sign in an account whose email is unverified. Signing invitations, completion notices
  and password resets are all email too. Any SMTP provider works; the four variables below are the
  host, the username, the password and the from address.
- Nothing else. The first account is created through Documenso's own sign-up page after deploy.

## Configuration

| Variable | Required | What it does |
|---|---|---|
| `NEXT_PRIVATE_SMTP_HOST` | yes | Hostname of your SMTP server. From your email provider. |
| `NEXT_PRIVATE_SMTP_USERNAME` | yes | Username for it. Often an API key id rather than an address. |
| `NEXT_PRIVATE_SMTP_PASSWORD` | yes | Password or API key for it. |
| `NEXT_PRIVATE_SMTP_FROM_ADDRESS` | yes | Address every Documenso email is sent from. Your provider has to let you send as it. |
| `NEXT_PRIVATE_SMTP_PORT` | no | Defaults to 587 (STARTTLS submission). Use 465 with `NEXT_PRIVATE_SMTP_SECURE` for implicit TLS. |
| `NEXT_PRIVATE_SMTP_SECURE` | no | Set to `true` to open the connection in TLS from the first byte. Leave empty for 587. |
| `NEXT_PRIVATE_SMTP_FROM_NAME` | no | Display name on the From header. The entrypoint uses `Documenso` when empty. |
| `NEXT_PRIVATE_SIGNING_LOCAL_FILE_CONTENTS` | no | Your own PKCS#12 certificate, base64 encoded. Set it and nothing is generated. Export it with `-keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1`; Documenso reads only the legacy PKCS#12 ciphers. |
| `NEXT_PRIVATE_SIGNING_PASSPHRASE` | no | Passphrase for that certificate. The generated one has none. |
| `NEXT_PUBLIC_DISABLE_SIGNUP` | no | Set to `true` to close sign-up once your own accounts exist. |
| `NEXT_PRIVATE_ALLOWED_SIGNUP_DOMAINS` | no | Comma-separated email domains allowed to sign up. A narrower alternative to closing it. |
| `NEXT_PUBLIC_DOCUMENT_SIZE_UPLOAD_LIMIT` | no | Largest upload Documenso offers, in MB. Defaults to 5. Every PDF is a row in Postgres here. |
| `NEXT_PRIVATE_DOCUMENSO_LICENSE_KEY` | no | Enterprise license key, from Documenso. Everything in the AGPL build works without it. |

Set by the template, not by you: `NEXT_PRIVATE_DATABASE_URL` points at the managed Postgres
service; `NEXTAUTH_SECRET`, `NEXT_PRIVATE_ENCRYPTION_KEY` and
`NEXT_PRIVATE_ENCRYPTION_SECONDARY_KEY` are generated 64-character secrets that sign the session
cookie and encrypt the secrets Documenso keeps in its own tables; `NEXT_PUBLIC_WEBAPP_URL` is this
service's own URL, which is what goes into every signing link it mails.

## After deploy

1. Open the service URL and click **Sign up**. Fill in your name, email and password, and draw a
   signature.
2. Check your inbox for the confirmation email and click the link in it. You cannot sign in until
   you do: an unverified account is refused at `/signin`.
3. Sign in. You land on the documents dashboard of your own personal organisation.
4. Click **Upload document**, pick a PDF, then add a recipient on the next screen. To sign it
   yourself, put in your own email.
5. Drag a **Signature** field onto the page, place it where the signature belongs, and click
   **Send**. With yourself as the only recipient the document appears straight away under
   **Documents** waiting to be signed.
6. Open it, sign the field, and complete. Documenso seals the PDF, the row moves to **Completed**,
   and **Download → Signed document** gives you the signed file. A PDF reader will report the
   signature as untrusted unless you replaced the self-signed certificate; the signature itself is
   real, the issuer is just not a CA anyone knows.
7. Close the door behind you: set `NEXT_PUBLIC_DISABLE_SIGNUP` to `true`, or restrict
   `NEXT_PRIVATE_ALLOWED_SIGNUP_DOMAINS`, so the public URL stops accepting new accounts.

`/api/health` reports the database and the certificate, and `/api/certificate-status` says in
detail what Documenso makes of the `.p12` it was given.

## Links

- Upstream: <https://github.com/documenso/documenso>
- Image: `docker.io/documenso/documenso`, with this directory's `Dockerfile` on top
- Documentation: <https://docs.documenso.com/docs/self-hosting>
- License: AGPL-3.0-only
