import {
  CodexAppServerClient,
  locateCodex,
} from '../dist/src/providers/codex/index.js';

const located = await locateCodex({
  override: process.env.DECAGRAM_COUNCIL_CODEX_BIN,
});

if (located === null) {
  throw new Error(
    'No supported Codex executable was found. Set DECAGRAM_COUNCIL_CODEX_BIN to verify an explicit installation.',
  );
}

const client = new CodexAppServerClient({
  executable: located.executable,
  clientVersion: '0.1.0-live-verifier',
});

try {
  const state = await client.connect();
  if (
    state.phase !== 'ready' ||
    !state.initialized ||
    state.account?.authenticated !== true
  ) {
    throw new Error(
      state.diagnostic ??
        'Codex App Server did not report an initialized, authenticated state.',
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      phase: state.phase,
      initialized: state.initialized,
      authenticated: state.account.authenticated,
      userAgent: state.userAgent,
      platformFamily: state.platformFamily,
      platformOs: state.platformOs,
      discoveredVia: located.discoveredVia,
      version: located.version,
    })}\n`,
  );
} finally {
  await client.stop();
}
