#!/usr/bin/env node
/**
 * AEGIS Desktop — social publishing CLI.
 *
 * The operator-facing entry point for the campaign described in
 * `docs/marketing-plan-social.md`. It is a thin wrapper: all behaviour lives in
 * `lib/run.mjs`, and all network shapes are built by `lib/channels.mjs`.
 *
 * Nothing here creates an account, and nothing here can. The four channel
 * accounts are created by hand (see `docs/social-publishing.md`); this tool
 * only publishes, from credentials the operator supplies, to the platforms'
 * own public APIs.
 *
 *   publish check     which channels are live, which are dark
 *   publish plan      exactly what would go out this week, per channel
 *   publish dry-run   the full pipeline with zero network writes
 *   publish post      actually send it — requires --live
 *
 * Exit codes (see EXIT in lib/run.mjs):
 *   0 ok · 1 usage · 2 config · 3 refused by a plan rule · 4 channel dark
 *   5 live failure
 */
import { ConfigError, UsageError, main } from './lib/run.mjs';

const argv = process.argv.slice(2);

/** Print a block of text, guaranteeing exactly one trailing newline. */
function emit(stream, text) {
  if (typeof text !== 'string' || text === '') return;
  stream.write(text.endsWith('\n') ? text : `${text}\n`);
}

try {
  const { code = 0, out } = await main(argv);
  emit(process.stdout, out);
  process.exit(code);
} catch (err) {
  if (err instanceof UsageError) {
    emit(process.stderr, `publish: ${err.message}`);
    process.exit(1);
  }
  if (err instanceof ConfigError) {
    emit(process.stderr, `publish: ${err.message}`);
    process.exit(2);
  }
  // Never let an unexpected fault print a stack trace: it can carry a
  // credential into a log file. Message only.
  emit(process.stderr, `publish: unexpected error: ${err && err.message ? err.message : err}`);
  process.exit(5);
}
