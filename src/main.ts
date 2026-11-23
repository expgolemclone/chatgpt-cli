#!/usr/bin/env node
import { parseArgs, type ParseArgsOptionDescriptor } from 'node:util';
import { assertStandardUser, openProfile } from './browser/edge.ts';
import type { Inspection } from './browser/inspect.ts';
import { createProfile, listProfiles, profileRoot } from './browser/profiles.ts';

const flags = {
  profile: { type: 'string', metavar: 'NAME', description: 'Use one name from chatgpt-cli profiles.' },
  'dry-run': { type: 'boolean', description: 'Print the planned prompts and seed without opening Edge or writing files.' },
  seed: { type: 'string', metavar: 'TEXT', description: 'Reproduce a preview while profiles and send history are unchanged.' },
  apply: { type: 'boolean', description: 'Permanently delete confirmed signed-out profiles.' },
  reference: { type: 'string', multiple: true, metavar: 'IMAGE', description: 'Attach a local PNG, JPEG, or WebP. Repeat for more images.' },
  help: { type: 'boolean', short: 'h', description: 'Show this help.' },
} as const;

type Option = ParseArgsOptionDescriptor & { description: string; metavar?: string };
type Values = {
  [K in keyof typeof flags]?: (typeof flags)[K] extends { type: 'boolean' } ? boolean
    : (typeof flags)[K] extends { multiple: true } ? string[] : string;
};
interface Command {
  description: string;
  options?: Record<string, Option>;
  args?: string[];
  requireProfile?: boolean;
  subcommands?: Record<string, Command>;
  notes?: string;
  run: (root: string, values: Values, args: string[]) => void | Promise<void>;
}

const noProfiles = 'No dedicated profiles. Run chatgpt-cli login to create one.';

function describeInspection(inspection: Inspection): string {
  if (inspection.status === 'logged_out') return 'Signed out.';
  if (inspection.status === 'unknown') return `Could not confirm sign-in (${inspection.reason}).`;
  const plan = inspection.state === 'plus' ? 'Plus' : inspection.state === '無料' ? 'Free' : 'unknown plan';
  return `Signed in as ${inspection.email_address} (${plan}).`;
}

const commands: Record<string, Command> = {
  login: {
    description: 'Create one profile and open Edge for manual sign-in.',
    options: { profile: flags.profile },
    notes: 'Use --profile to reopen an existing profile instead of creating a new one.',
    async run(root, { profile: name }) {
      const profile = name === undefined ? createProfile(root) : listProfiles(root, name)[0]!;
      await openProfile(profile, 'https://chatgpt.com/');
      console.log(`Opened ${profile.name}. Sign in to ChatGPT in Edge.`);
    },
  },
  open: {
    description: 'Open your profiles at ChatGPT Usage in Edge.',
    options: { profile: flags.profile },
    async run(root, { profile: name }) {
      const profiles = listProfiles(root, name);
      if (!profiles.length) console.log(noProfiles);
      for (const profile of profiles) {
        await openProfile(profile, 'https://chatgpt.com/#settings/Usage');
        console.log(`Opened ${profile.name}.`);
      }
    },
  },
  profiles: {
    description: 'List profile names, or check, sync, or prune them.',
    notes: 'Only marked profiles in %LOCALAPPDATA%/chatgpt-cli/profiles are used. Archived profiles are excluded.',
    run(root) {
      const profiles = listProfiles(root);
      console.log(profiles.length ? profiles.map(profile => profile.name).join('\n') : noProfiles);
    },
    subcommands: {
      check: {
        description: 'Check one profile for sign-in and its personal plan.',
        options: { profile: flags.profile },
        requireProfile: true,
        notes: 'Use a non-elevated terminal and close the profile in Edge first.',
        async run(root, { profile: name }) {
          await assertStandardUser();
          const profile = listProfiles(root, name)[0]!;
          const { inspectProfile } = await import('./browser/inspect.ts');
          console.log(`${profile.name}: ${describeInspection(await inspectProfile(profile))}`);
        },
      },
      sync: {
        description: 'Update a private CSV and name confirmed profiles after their email address.',
        args: ['ACCOUNTS.csv'],
        options: { profile: flags.profile },
        notes: 'Use an existing CSV with kind,value,state columns and a non-elevated terminal. Close the selected profiles in Edge first.',
        async run(root, { profile: name }, [ledger]) {
          await assertStandardUser();
          const { syncUsage } = await import('./usage/sync.ts');
          const results = await syncUsage(root, ledger!, name);
          if (!results.length) console.log(noProfiles);
          for (const result of results) {
            const updates = [result.updated && 'Ledger updated.', result.renamed && 'Profile renamed.'].filter(Boolean);
            console.log([`${result.profile.name}: ${describeInspection(result)}`, ...updates].join(' '));
          }
        },
      },
      prune: {
        description: 'Preview removal of confirmed signed-out profiles.',
        options: { apply: flags.apply },
        notes: 'Use a non-elevated terminal and close dedicated Edge windows. The preview contacts ChatGPT and starts the five-minute inspection cooldown.',
        async run(root, { apply }) {
          await assertStandardUser();
          const { pruneProfiles } = await import('./browser/prune.ts');
          for await (const { profile, action, reason } of pruneProfiles(root, apply)) {
            const label = action === 'would-delete' ? 'Would delete' : action === 'deleted' ? 'Deleted' : 'Kept';
            console.log(`${label} ${profile.name} (${reason}).`);
          }
        },
      },
    },
  },
  send: {
    description: 'Send scheduled prompt batches to signed-in Free profiles.',
    options: { 'dry-run': flags['dry-run'], profile: flags.profile, seed: flags.seed },
    notes: [
      'Start with --dry-run. A live send closes any open Edge windows in the selected dedicated profiles.',
      'It visits Free profiles in 5 loops, with 5 rounds per visit and at least 30 seconds (plus jitter) between profile visits and submissions.',
      'In collection runs, non-free and initially signed-out profiles are skipped.',
      'Uses a non-elevated terminal. Checks challenges without interacting with verification controls.',
      'Stops on five consecutive Cloudflare challenge responses or other unresolved access or session failures.',
      'After an incomplete send, collection-wide and unattended runs cool down for 30 minutes.',
    ].join('\n'),
    async run(root, { profile: name, seed, 'dry-run': dryRun }) {
      const { send } = await import('./send.ts');
      await send(root, name, seed, dryRun);
    },
  },
  image: {
    description: 'Generate one PNG from a UTF-8 brief using a Plus profile.',
    args: ['BRIEF.txt', 'NEW.png'],
    options: { profile: flags.profile, reference: flags.reference },
    requireProfile: true,
    notes: 'Use a non-elevated terminal. Sign in to personal Plus and close the profile in Edge. Paths are relative to the current directory. Success prints only the PNG path.',
    async run(root, { profile: name, reference }, [brief, output]) {
      await assertStandardUser();
      const profile = listProfiles(root, name)[0]!;
      const { acquireSendLock } = await import('./send-lock.ts');
      const release = acquireSendLock();
      try {
        const { generateImage } = await import('./image.ts');
        console.log(await generateImage(profile, brief!, output!, reference));
      } finally { release(); }
    },
  },
};

function optionName(name: string, option: Option): string {
  return `--${name}${option.metavar ? ' ' + option.metavar : ''}`;
}

function usage(name: string, command: Command): string {
  const args = [name, ...(command.args ?? [])];
  if (command.requireProfile) args.push(optionName('profile', flags.profile));
  if (command.options && Object.keys(command.options).some(key => key !== 'profile' || !command.requireProfile)) {
    args.push('[options]');
  }
  return 'Usage: chatgpt-cli ' + args.join(' ');
}

function helpList(entries: [string, string][]): string[] {
  const width = Math.max(...entries.map(([name]) => name.length));
  return entries.map(([name, description]) => `  ${name.padEnd(width)}  ${description}`);
}

async function main([first, ...args]: string[]): Promise<void> {
  if (first === undefined || first === '--help' || first === '-h') {
    if (args.length) throw new Error('Run chatgpt-cli COMMAND --help for command help.');
    console.log([
      'Usage: chatgpt-cli COMMAND [options]', '',
      ...helpList(Object.entries(commands).map(([name, command]) => [name, command.description])),
      '', 'Start with chatgpt-cli login. Run chatgpt-cli COMMAND --help for options.',
    ].join('\n'));
    return;
  }
  if (!Object.hasOwn(commands, first)) throw new Error(`Unknown command: ${first}. Run chatgpt-cli --help.`);
  let command = commands[first]!;
  let name = first;
  const operation = args[0];
  if (command.subcommands && operation && !operation.startsWith('-')) {
    if (!Object.hasOwn(command.subcommands, operation)) {
      throw new Error(`Unknown profiles command: ${operation}. Run chatgpt-cli profiles --help.`);
    }
    command = command.subcommands[operation]!;
    name += ' ' + operation;
    args = args.slice(1);
  }
  const options: Record<string, Option> = { ...command.options, help: flags.help };
  const invalid = (message: string) => new Error(`${message}\nRun chatgpt-cli ${name} --help for usage.`);
  let parsed;
  try {
    parsed = parseArgs({ args, options, allowPositionals: true, tokens: true });
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error));
  }
  const { positionals, tokens } = parsed;
  const values = parsed.values as Values;
  if (values.help) {
    console.log([
      usage(name, command), '', command.description,
      ...(command.subcommands ? ['', 'Commands:',
        ...helpList(Object.entries(command.subcommands).map(([key, subcommand]) => [key, subcommand.description]))] : []),
      '', 'Options:', ...helpList(Object.entries(options).map(([key, option]) => [optionName(key, option), option.description])),
      ...(command.notes ? ['', command.notes] : []),
    ].join('\n'));
    return;
  }
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name) && !options[token.name]?.multiple) throw invalid(`Use --${token.name} only once.`);
    if (token.value !== undefined && !token.value.trim()) throw invalid(`--${token.name} requires a nonempty value.`);
    seen.add(token.name);
  }
  if (positionals.length !== (command.args?.length ?? 0) || positionals.some(arg => !arg.trim()) ||
      (command.requireProfile && values.profile === undefined)) {
    throw invalid(usage(name, command));
  }
  if (process.platform !== 'win32') throw new Error('This command requires Windows and Microsoft Edge.');
  await command.run(profileRoot(), values, positionals);
}

main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
