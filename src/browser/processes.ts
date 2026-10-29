import koffi from 'koffi';
import { isAbsolute, parse, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { assertIdentity, edgeExecutable } from './edge.ts';
import { resolveProfiles, type Profile } from './profiles.ts';

const kernel = koffi.load('kernel32.dll');
const shell = koffi.load('shell32.dll');
const ntdll = koffi.load('ntdll.dll');
const enumerate = kernel.func('int __stdcall K32EnumProcesses(_Out_ uint32_t *pids, uint32_t bytes, _Out_ uint32_t *used)');
const open = kernel.func('intptr_t __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)');
const close = kernel.func('int __stdcall CloseHandle(intptr_t handle)');
const image = kernel.func('int __stdcall QueryFullProcessImageNameW(intptr_t handle, uint32_t flags, _Out_ uint16_t *name, _Inout_ uint32_t *length)');
const query = ntdll.func('uint32_t __stdcall NtQueryInformationProcess(intptr_t handle, uint32_t kind, void *buffer, uint32_t size, _Out_ uint32_t *used)');
const argv = shell.func('void * __stdcall CommandLineToArgvW(str16 command, _Out_ int *count)');
const free = kernel.func('void * __stdcall LocalFree(void *memory)');
const terminate = kernel.func('int __stdcall TerminateProcess(intptr_t handle, uint32_t code)');
const wait = kernel.func('uint32_t __stdcall WaitForSingleObject(intptr_t handle, uint32_t milliseconds)');
const unicode = koffi.struct({ length: 'uint16_t', maximum: 'uint16_t', buffer: 'void *' });

/** Use Windows' parser, including its quoting and backslash rules, not shell parsing. */
export function profileDirectory(command: string): string | undefined {
  const count = [0];
  const pointer = argv(command, count);
  if (!pointer) throw new Error('Cannot parse the Edge command line; no prompts will be sent.');
  let arguments_: string[];
  try {
    arguments_ = koffi.decode(pointer, 'str16', count[0]!) as string[];
  } finally { free(pointer); }
  // Chromium trims arguments and has a shell-only single-argument mode. Reject those ambiguous forms.
  if (arguments_.some(argument => /^[\s\u0085]|[\s\u0085]$/.test(argument))) return undefined;
  const separator = arguments_.indexOf('--', 1);
  const options = arguments_.slice(1, separator === -1 ? undefined : separator);
  if (options.some(argument => /^(?:--?|\/)single-argument(?:=|$)/i.test(argument))) return undefined;
  const switches = options.map(argument => /^(?:--?|\/)user-data-dir(?:=(.*))?$/i.exec(argument))
    .filter(match => match !== null);
  // Chromium switch values require "=". A missing/empty or duplicate value is not a dedicated directory.
  const directory = switches.length === 1 ? switches[0]![1] : undefined;
  return directory && isAbsolute(directory) && parse(directory).root.length > 1
    ? resolve(directory).toLowerCase() : undefined;
}

function commandLine(handle: number | bigint): string | undefined {
  // A Windows command line is at most 32767 UTF-16 characters, plus the UNICODE_STRING header.
  const buffer = Buffer.alloc(65_536 + koffi.sizeof(unicode));
  const status = query(handle, 60 /* ProcessCommandLineInformation */, buffer, buffer.length, null);
  if (status !== 0) {
    if (wait(handle, 0) === 0) return undefined; // The process exited during enumeration.
    throw new Error('Cannot read a running Edge command line; no browsers will be terminated.');
  }
  const value = koffi.decode(buffer, unicode) as { length: number; buffer: bigint };
  const offset = Number(value.buffer - koffi.address(buffer));
  if (value.length % 2 || offset < koffi.sizeof(unicode) || offset + value.length > buffer.length) {
    throw new Error('Incomplete Edge command line; no browsers will be terminated.');
  }
  return buffer.toString('utf16le', offset, offset + value.length);
}

/** Terminate only validated selected profiles, holding process handles so PID reuse cannot target another process. */
export async function terminateProfiles(profiles: Profile[]): Promise<{ profile: Profile; pid: number }[]> {
  if (!profiles.length) return [];
  resolveProfiles(profiles.map(profile => profile.path));
  for (const profile of profiles) assertIdentity(profile);
  const executable = resolve(edgeExecutable()).toLowerCase();
  let pids = new Uint32Array(256);
  const used = [0];
  for (;;) {
    if (!enumerate(pids, pids.byteLength, used)) throw new Error('Process inventory failed; no browsers will be terminated.');
    if (used[0]! < pids.byteLength) break;
    pids = new Uint32Array(pids.length * 2);
  }

  const targets: { profile: Profile; pid: number; handle: number | bigint }[] = [];
  try {
    for (const pid of pids.subarray(0, used[0]! / 4)) {
      const handle: number | bigint = open(0x1000 | 0x100000 /* QUERY_LIMITED_INFORMATION | SYNCHRONIZE */, 0, pid);
      if (!handle) continue; // System/protected processes cannot own an automatable dedicated profile.
      try {
        const name = Buffer.alloc(65_536);
        const length = [name.length / 2];
        if (!image(handle, 0, name, length) ||
            resolve(name.toString('utf16le', 0, length[0]! * 2)).toLowerCase() !== executable) continue;
        const command = commandLine(handle);
        if (command === undefined) continue;
        const directory = profileDirectory(command);
        const profile = profiles.find(profile => resolve(profile.path).toLowerCase() === directory);
        if (!profile) continue;
        // Keep the query handle until the termination handle is acquired. The PID cannot be recycled in between.
        const owned: number | bigint = open(0x1 | 0x100000 /* TERMINATE | SYNCHRONIZE */, 0, pid);
        if (!owned) throw new Error('Cannot terminate the selected Edge profile; no prompts will be sent.');
        targets.push({ profile, pid, handle: owned });
      } finally { close(handle); }
    }
    // Finish selection before terminating anything, so discovery/permission errors cannot partially kill the batch.
    for (const target of targets) {
      if (wait(target.handle, 0) !== 0 && !terminate(target.handle, 1) && wait(target.handle, 0) !== 0) {
        throw new Error('Selected Edge profile could not be terminated; no prompts will be sent.');
      }
    }
    const deadline = Date.now() + 10_000;
    while (targets.some(target => wait(target.handle, 0) !== 0)) {
      if (Date.now() >= deadline) throw new Error('Selected Edge profiles did not exit; no prompts will be sent.');
      await setTimeout(100);
    }
    return targets.map(({ profile, pid }) => ({ profile, pid }));
  } finally {
    for (const target of targets) close(target.handle);
  }
}
