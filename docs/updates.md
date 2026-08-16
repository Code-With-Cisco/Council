# Application updates

Decagram Council uses `electron-updater` with the electron-builder NSIS target
and GitHub Releases from `Code-With-Cisco/Council`.

The repository is publicly readable, so installed apps do not embed a GitHub
token. As of the 0.2.0 implementation pass it has no published releases; the
first reviewed `v0.2.0` draft must be published before update checks have a
release feed to read.

Updates are deliberately user-driven:

1. **Check for updates** reads the latest published GitHub release metadata.
2. **Download update** downloads and verifies the artifact described by
   `latest.yml`.
3. **Install and relaunch** asks for confirmation, drains Council's active
   runtime and provider connections, launches the NSIS updater, and starts the
   new version.

Development builds do not update themselves. Closing the app after downloading
also does not silently install because automatic download and install-on-quit
are disabled.

## First updater-enabled installation

The previously installed 0.1.0 application has no updater code and cannot
discover 0.2.0 by itself. Install the reviewed 0.2.0 NSIS installer manually
over 0.1.0 once. The per-user NSIS configuration keeps the same application ID
and upgrade location. After 0.2.0 is installed, future higher published
versions can use the in-app flow.

## Publishing an update

1. Change `version` in `package.json` and `package-lock.json` to a higher valid
   semantic version, such as `0.2.1`.
2. Complete the release verification matrix and commit the release.
3. Create and push the matching tag, such as `v0.2.1`.
4. The `Release Windows update` workflow runs TypeScript and tests, builds the
   Windows installer, and uploads a **draft** GitHub Release.
5. Review the draft. It must contain the NSIS installer, its blockmap, and
   `latest.yml`. Publish the draft only after those files and the version have
   been verified.
6. In an older installed app, select **Check for updates** and exercise the
   download/install/relaunch flow.

The tag must exactly equal `v` plus the package version; the workflow fails
before publishing if they differ. A normal branch push never publishes a
release. The repository's Actions token is used only by the tagged release job.

## Signing

Production releases should be Authenticode-signed with a consistent publisher
certificate. Configure electron-builder signing secrets in the repository
before treating the updater as production-ready. GitHub HTTPS and the SHA-512
value in `latest.yml` protect transport and artifact integrity, but they do not
replace Windows publisher identity and reputation.
