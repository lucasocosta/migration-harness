#!/usr/bin/env node
import { findCommand, renderHelpJson, renderHelpText, renderIndexJson, renderIndexText } from './help.js';
import { diagnose, diagnosticError, errorEnvelope, formatDiagnostic } from './errors.js';
import { isV2Command, runV2 } from './v2/commands.js';

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  // Asking for help is never an error: it is answered before option parsing, so `--help` works on
  // every command (and with unknown flags still on the line), always exits 0 and always has a JSON form.
  const wantsHelp = args.includes('--help') || args.includes('-h');
  const bareHelp = command === undefined || command === '--help' || command === '-h' || command === 'help';
  if (bareHelp || wantsHelp) {
    // `help <cmd>`, `--help <cmd>` and `<cmd> --help` all resolve to one command; otherwise the index.
    const target = !bareHelp ? command
      : args.find(argument => !argument.startsWith('-')) ?? (wantsHelp && command === 'help' ? 'help' : undefined);
    if (target !== undefined && !findCommand(target)) throw diagnosticError('UNKNOWN_COMMAND', `Unknown command "${target}".`);
    if (target !== undefined) process.stdout.write(jsonMode ? renderHelpJson(target) : `${renderHelpText(target)}\n`);
    else process.stdout.write(jsonMode ? `${renderIndexJson()}\n` : `${renderIndexText()}\n`);
    return;
  }
  // CLI v2 (PLAN-V2 §3) is the whole surface: the six commands parse their own flags and always emit
  // one envelope (stdout in --json mode). Everything else is a structured refusal, never a silent
  // success and never a bare stack — the retired compatibility commands answer UNKNOWN_COMMAND.
  if (command !== undefined && isV2Command(command)) { await runV2(command, args); return; }
  throw diagnosticError('UNKNOWN_COMMAND', `Unknown command "${command}".`);
}
// Every failure leaves through one place: a catalogued, privacy-screened diagnostic (see errors.ts and
// docs/reference/errors.md). Text mode is human-readable; `--json` mode is the { ok: false, error: {...} }
// envelope. Both go to stderr so stdout stays a pure result channel, and exit codes never change.
main().catch(error => {
  const diagnostic = diagnose(error);
  console.error(process.argv.includes('--json') ? JSON.stringify(errorEnvelope(diagnostic)) : formatDiagnostic(diagnostic));
  process.exitCode = 1;
});
