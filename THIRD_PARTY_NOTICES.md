# Third-party notices

## jackwener/weibo-cli

The Weibo Passport QR authentication flow in [`src/auth.ts`](src/auth.ts) is adapted and rewritten in TypeScript from the Python implementation in:

- Project: `jackwener/weibo-cli`
- Source: <https://github.com/jackwener/weibo-cli/blob/main/weibo_cli/auth.py>
- Author/project owner: jackwener and contributors
- Upstream declared license: Apache License 2.0, as stated in its `pyproject.toml` and README
- License text: [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt)

The adaptation keeps the public Passport workflow—obtain `X-CSRF-TOKEN`, request a QR session, render the scan URL, poll its status, and follow SSO cross-domain redirects—but replaces Python/httpx with TypeScript/Axios and `tough-cookie`. It also adds QR PNG output, configurable activation delay, credential verification, project-local credential storage with `0600` permissions, and removes automatic local-browser Cookie extraction.

The overall `weibo-core` project is distributed under AGPL-3.0-or-later. The Apache-2.0 terms and attribution continue to apply to the adapted material described above.

## Research references not incorporated as code

The following projects informed feature and architecture research, but no source code from them is copied or adapted into this repository:

- `dataabc/weibo-crawler`: <https://github.com/dataabc/weibo-crawler>
- `NanmiCoder/MediaCrawler`, Weibo client: <https://github.com/NanmiCoder/MediaCrawler/blob/main/media_platform/weibo/client.py>

At the time of review on 2026-08-29, `dataabc/weibo-crawler` did not expose a repository `LICENSE` file. MediaCrawler's referenced file is licensed under its `NON-COMMERCIAL LEARNING LICENSE 1.1`. Their names and links are included only to document research provenance and do not imply endorsement of this project.
