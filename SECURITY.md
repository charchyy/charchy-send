# Security

## Reporting a vulnerability

Email **support@charchy.krd** with "Security" in the subject: what you found, how to reproduce it, and the version. Please don't open a public issue for a vulnerability. We will reply, and tell you when a fix ships.

That covers this SDK and the Charchy Send API it talks to.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes — fixes ship as 0.1.x patches |
| Older | — |

Until 1.0, only the latest minor version gets fixes.

## What the SDK does to keep your key safe

- The API key lives in a private field: `console.log`, `util.inspect` and `JSON.stringify` of the client, its results and its errors show `chy_live_…<last four>`, never the key.
- Requests go only to an `https://` base URL (plain `http://` only for localhost), redirects are never followed, and nothing it sends can carry a line break into a header.
- Webhook signatures are compared in constant time, with a 5-minute replay window.
- Releases are published from GitHub Actions with npm provenance: `npm view @charchy/send --json` shows the attestation, linking each version to the commit and workflow run that built it.
