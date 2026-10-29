# Transactional email and deliverability

Status: **provider integration built, external domain setup outstanding.**

The Resend API accepts messages from the integration, but the only sender that
works without a verified domain is `onboarding@resend.dev`, and Resend restricts
it to the Resend account owner's address. A test sent to the account owner was
accepted and arrived in **spam**. That is the expected result for the shared test
sender: it has no domain-specific SPF/DKIM/DMARC alignment with Inverge.

Do not treat "Resend returned 200" as "the recipient received it in their inbox".
Only a verified domain plus a real inbox check makes that claim.

## What must be configured

1. **A domain you control.** Add it in Resend -> Domains. A subdomain such as
   `mail.inverge.africa` is enough and keeps the root domain's existing mail
   separate. Copy the exact DNS records Resend shows; do not invent values.
2. **SPF, DKIM and DMARC.**
   - Add Resend's MX/TXT/CNAME records for the sending subdomain exactly as shown.
   - Publish a DMARC record on the root domain (Resend's domain page links to
     its DMARC guide). Start with monitoring (`p=none`) and a reporting address
     you actually read; tighten to `quarantine`/`reject` only after the reports
     are clean.
   - Wait for Resend to report the domain as **Verified**.
3. **Sender identity.**
   - `EMAIL_FROM` = a mailbox on the verified domain, for example
     `no-reply@mail.inverge.africa`.
   - `EMAIL_FROM_NAME=Inverge`.
   - `EMAIL_REPLY_TO` = a monitored mailbox (for example `hello@inverge.africa`)
     so replies do not disappear.
4. **A sending-only API key** restricted to that domain. Never put a full-access
   key in the API, the web app, a commit, or chat.
5. **Render environment** on `inverge-api-staging` (and production later):

   ```env
   NODE_ENV=production
   EMAIL_PROVIDER=resend
   RESEND_API_KEY=<sending-only key>
   EMAIL_FROM=no-reply@mail.<verified-domain>
   EMAIL_FROM_NAME=Inverge
   EMAIL_REPLY_TO=<monitored mailbox>
   EMAIL_CODE_SECRET=<32+ random characters, unique per environment>
   ```

   `NODE_ENV=production` rejects `EMAIL_PROVIDER=stub`, so the service will not
   boot until Resend is configured.

## Why the test landed in spam

- `onboarding@resend.dev` is a shared test sender. Gmail has no reason to trust
  it for Inverge mail.
- The message has no Inverge-domain DKIM signature or SPF alignment.
- A brand-new sending domain also has no reputation. Expect some filtering until
  volume and engagement establish reputation.

The code cannot fix inbox placement. Domain authentication and reputation can.

## Verification procedure after DNS is live

1. `npx resend-cli doctor` (or the Resend dashboard) shows the domain verified.
2. Send one real verification email through the API to a mailbox on a domain you
   control, not a shared test address.
3. Confirm:
   - the message shows `delivered` in Resend;
   - Gmail's "Show original" reports `SPF: PASS`, `DKIM: PASS` for the sending
     domain, and an aligned DMARC result;
   - the code works once, expires, and a reused code is rejected.
4. Send a second message with the same idempotency key and confirm only one
   message exists.
5. Repeat to a Gmail address after the domain has some history. If it still
   lands in spam, use Google Postmaster Tools and Resend's deliverability
   insights before changing code.

## Local development

`EMAIL_PROVIDER=stub` writes rendered messages to `.local/email-outbox/` (gitignored)
and refuses to run with `NODE_ENV=production`. It never logs the code. This is a
development aid, not a delivery provider.

## Unresolved external work

- No domain has been added to Resend in this repository's setup.
- No SPF/DKIM/DMARC records have been published or verified.
- No production sender address exists.
- The staging Render service has not been given the Resend key or sender.
- The current test message was accepted by Resend but landed in spam.
