# Third-party notices

## Scope and attribution rule

This file separates code that is actually adapted from research references that were only inspected for behavior or API shape. A repository being public, non-commercial, or intended for learning does not by itself grant permission to copy its source. Unless a section explicitly says otherwise, no source code from the listed research references is included in `weibo-core`.

The project itself is distributed under AGPL-3.0-or-later. The notices below preserve the upstream names, links, and applicable license information so a future maintainer can audit why a behavior or interface was selected.

## jackwener/weibo-cli

The Weibo Passport QR authentication flow in [`src/auth.ts`](src/auth.ts) is adapted and rewritten in TypeScript from the Python implementation in:

- Project: `jackwener/weibo-cli`
- Source: <https://github.com/jackwener/weibo-cli/blob/main/weibo_cli/auth.py>
- Author/project owner: jackwener and contributors
- Upstream declared license: Apache License 2.0, as stated in its `pyproject.toml` and README
- License text: [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt)

The adaptation keeps the public Passport workflow—obtain `X-CSRF-TOKEN`, request a QR session, render the scan URL, poll its status, and follow SSO cross-domain redirects—but replaces Python/httpx with TypeScript/Axios and `tough-cookie`. It also adds QR PNG output, configurable activation delay, credential verification, project-local credential storage with `0600` permissions, and removes automatic local-browser Cookie extraction.

The overall `weibo-core` project is distributed under AGPL-3.0-or-later. The Apache-2.0 terms and attribution continue to apply to the adapted material described above.

## yt-dlp

The media resolver's Weibo endpoint and format-selection behavior was informed by the Weibo extractor in:

- Project: `yt-dlp/yt-dlp`
- Source: <https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/weibo.py>
- Authors: yt-dlp contributors
- Upstream license: The Unlicense
- License text: [`LICENSES/Unlicense.txt`](LICENSES/Unlicense.txt)

The implementation in this repository is an independent TypeScript implementation. It resolves a post immediately before downloading, selects the largest image and highest available video playback format, falls back to the legacy component endpoint, refreshes expired signed URLs, resumes partial files, and deliberately excludes transient CDN URLs from persistent manifests.

The Unlicense text is retained in [`LICENSES/Unlicense.txt`](LICENSES/Unlicense.txt) for attribution and auditability. This notice does not claim that the Weibo extractor or any other yt-dlp source file is a runtime dependency.

## Research references not incorporated as code

The following projects informed feature and architecture research, but no source code from them is copied or adapted into this repository:

- `dataabc/weibo-crawler`: <https://github.com/dataabc/weibo-crawler>
- `NanmiCoder/MediaCrawler`, Weibo client: <https://github.com/NanmiCoder/MediaCrawler/blob/main/media_platform/weibo/client.py>
- `gbandszxc/weibo-image-downloader`: <https://github.com/gbandszxc/weibo-image-downloader>
- `JeffreyCA/weibo-video-downloader`: <https://github.com/JeffreyCA/weibo-video-downloader>

At the time of their respective reviews, `dataabc/weibo-crawler`, `gbandszxc/weibo-image-downloader`, and `JeffreyCA/weibo-video-downloader` did not expose a repository-level `LICENSE` file. Publicly visible source without a license is not permission to copy, modify, or redistribute it, even for a non-commercial or learning-only project. MediaCrawler's referenced file is licensed under its `NON-COMMERCIAL LEARNING LICENSE 1.1`. No code from these research references is copied, translated, or adapted into this repository; their names and links document research provenance only and do not imply endorsement.
