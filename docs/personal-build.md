# Personal Buzz build: Claude subscription sign-in

This is a personal test build, not an official Buzz release. It includes the
public subscription sign-in patch from block/buzz-app PR #2995, snapshot
23a7fbdbc42e70c98fb39373cb57040470bd486f. Its base is upstream snapshot
7f35bb147f71456eeb50a3e4d11d278097cc6a0e. Later upstream changes are not included.
This build also prevents a cancelled existing-account probe from saving an
authentication change; a focused regression test covers that cancellation.

Ordinary direct messages to Claude now request answers in the main conversation,
matching the DM send default. Messages explicitly sent inside an existing thread
continue that thread. This changes future answers; it does not move or rewrite
older replies already stored in threads.

The GitHub-hosted macOS runner builds for Apple Silicon. No personal Claude,
ChatGPT, Buzz credentials or Apple signing credentials are uploaded. Login is
tested only on the destination Mac. Automated tests use fixtures, not accounts.

The application is ad-hoc signed and is not notarized by Apple. It does not use
the official updater, so updates require rebuilding or returning to the official
application. The archive preserves the app bundle and includes SHA-256 checksums
and its source commit. Keep the original installed app before trying this build.
Do not run both Buzz copies simultaneously: this build retains Buzz's application
identifier, URL scheme and data locations. Existing Buzz data may be reused;
do not delete or migrate it to perform this test. Mac keychain access may require
manual approval for this newly signed application.

## Acceptance on the destination Mac

1. Verify the archive against SHA256SUMS and keep the original app available.
2. Quit the official Buzz before opening this copy. If macOS blocks the app,
   inspect the warning yourself; do not disable Gatekeeper system-wide.
3. In Settings > Agent setup > Harness defaults > Claude, choose Edit
   configuration, then Use Claude account or Sign in. A previously saved API key
   wins until you select the Claude account. There is no need to delete the key.
4. Verify that Claude shows the subscription account. Start a new session for
   the direct conversation, then send a small prompt from its main composer:
   Claude should answer in the main chat. Send a follow-up inside an explicit
   thread and verify that answer stays in that thread.
5. Verify that the existing Codex agent still answers through its ChatGPT login.
6. Quit and reopen; verify the account choice persists.

Security reviews for protected Claude agents still require an API key, as in the
upstream patch. This build does not remove those protections. Ordinary account
sign-in is not proof that these separate security reviews work.

Build success is not end-to-end validation. Until the above checks have been
performed, treat the download as a candidate for testing.
