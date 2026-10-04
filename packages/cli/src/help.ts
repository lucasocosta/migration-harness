/**
 * The command registry: every CLI command, its usage line, flags, exit codes and an executable
 * example. Text help, `--help --json` and `harness help` all project this one registry, so usage
 * can never drift between the three views. It holds exactly the six CLI v2 commands (see
 * v2/help.ts); `nextActions` validates its argument names against these flags too.
 */
import { V2_COMMANDS } from './v2/help.js';
export interface HelpFlag {
  /** Flag as spelled on the command line, e.g. `--config`. */
  readonly name: string;
  /** Value placeholder when the flag takes one, e.g. `<migration.json>`. */
  readonly value?: string;
  readonly required: boolean;
  readonly description: string;
}

export interface HelpExitCode {
  readonly code: number;
  readonly meaning: string;
}

export interface CommandHelp {
  readonly command: string;
  readonly summary: string;
  readonly usage: string;
  readonly flags: readonly HelpFlag[];
  readonly exitCodes: readonly HelpExitCode[];
  readonly example: string;
  /**
   * Ordered refusal codes this command can emit, highest precedence first (PLAN-V2 §11.2 A4):
   * only the first matching refusal is reported, so an operator can predict which reason wins when
   * several apply to the same invocation. Projected by `--help --json`.
   */
  readonly refusalPrecedence?: readonly string[];
}

/**
 * The whole registry is the six CLI v2 commands (PLAN-V2 §3): the retired compatibility commands
 * were removed by the kill switch, so `harness --help`, `harness help <cmd>` and `<cmd> --help`
 * project exactly one surface and a retired name answers UNKNOWN_COMMAND.
 */
export const COMMANDS: readonly CommandHelp[] = V2_COMMANDS;

const BY_COMMAND = new Map(COMMANDS.map(entry => [entry.command, entry]));

export function findCommand(command: string): CommandHelp | undefined { return BY_COMMAND.get(command); }

const flagLine = (help: HelpFlag): string => `  ${help.name}${help.value ? ` ${help.value}` : ''}`;

/** Text projection: usage first (so `--help` output is scannable from the top), then flags, exit codes and an example. */
export function renderHelpText(command: string): string {
  const entry = findCommand(command);
  if (!entry) return renderIndexText();
  const width = Math.max(...entry.flags.map(help => flagLine(help).length));
  const flags = entry.flags.length
    ? `Flags:\n${entry.flags.map(help => `${flagLine(help).padEnd(width)}  ${help.required ? '[required]' : '[optional]'}  ${help.description}`).join('\n')}`
    : 'Flags: none';
  const exitCodes = entry.exitCodes.map(item => `${item.code} ${item.meaning}`).join('; ');
  const precedence = entry.refusalPrecedence ? `\nRefusal precedence: ${entry.refusalPrecedence.join(' > ')}` : '';
  return `${entry.usage}\n${entry.summary}\n${flags}\nExit codes: ${exitCodes}${precedence}\nExample: ${entry.example}`;
}

/** Structured projection: exactly { command, summary, usage, flags, exitCodes, example[, refusalPrecedence] }. */
export function renderHelpJson(command: string): string {
  const entry = findCommand(command);
  if (!entry) return `${renderIndexJson()}\n`;
  return `${JSON.stringify({
    command: entry.command,
    summary: entry.summary,
    usage: entry.usage,
    flags: entry.flags.map(help => ({ name: help.name, required: help.required, description: help.description })),
    exitCodes: entry.exitCodes.map(item => ({ code: item.code, meaning: item.meaning })),
    example: entry.example,
    ...(entry.refusalPrecedence ? { refusalPrecedence: [...entry.refusalPrecedence] } : {}),
  }, null, 2)}\n`;
}

export const GLOBAL_EXIT_CODES: readonly HelpExitCode[] = [
  { code: 0, meaning: 'success (a request for help is never an error)' },
  { code: 1, meaning: 'invalid input, refused operation or unexpected error' },
  { code: 3, meaning: 'refused: a session refusal or stop (it prevails over a PASS report)' },
  { code: 4, meaning: 'evaluation FAIL with no higher-priority stop' },
  { code: 5, meaning: 'INCONCLUSIVE: evidence could not decide' },
];

/** Help without a command: one line per command, plus the global exit-code contract. */
export function renderIndexText(): string {
  const width = Math.max(...COMMANDS.map(entry => entry.command.length));
  const rows = [...COMMANDS]
    .sort((left, right) => left.command.localeCompare(right.command))
    .map(entry => `  ${entry.command.padEnd(width)}  ${entry.summary.split('.')[0]}.`)
    .join('\n');
  const exitCodes = GLOBAL_EXIT_CODES.map(item => `${item.code} ${item.meaning}`).join('; ');
  return `Migration Harness CLI — ${COMMANDS.length} commands\n\n${rows}\n\nExit codes: ${exitCodes}\nUse "<command> --help" for usage, flags, exit codes and an example; add "--json" for the same help as structured JSON.\nUse "harness help <command>" for one command. Reference: docs/OPERATOR.md, docs/reference/errors.md`;
}

export function renderIndexJson(): string {
  return JSON.stringify({
    commands: [...COMMANDS]
      .sort((left, right) => left.command.localeCompare(right.command))
      .map(entry => ({ command: entry.command, summary: entry.summary, usage: entry.usage })),
    exitCodes: GLOBAL_EXIT_CODES.map(item => ({ code: item.code, meaning: item.meaning })),
    operator: 'docs/OPERATOR.md',
    errors: 'docs/reference/errors.md',
  }, null, 2);
}
