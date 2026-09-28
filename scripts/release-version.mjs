// First step of release.yml: turns the pushed tag into the version to publish.
//
//   node scripts/release-version.mjs "$GITHUB_REF_NAME" >> "$GITHUB_OUTPUT"
//
// Prints `version=<X.Y.Z>`. Fails unless the tag is v<X.Y.Z>, every workspace package.json has
// that version and release-notes/<X.Y.Z>.md exists (so a mistyped tag never publishes anything).
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { releaseVersionFromTag } from './lib/releaseFiles.mjs';

try {
  const version = releaseVersionFromTag(process.argv[2] ?? '', fileURLToPath(new URL('..', import.meta.url)));
  console.log(`version=${version}`);
} catch (e) {
  console.error(`release-version: ${/** @type {Error} */ (e).message}`);
  process.exit(1);
}
