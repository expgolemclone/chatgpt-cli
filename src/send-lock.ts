import koffi from 'koffi';

const kernel = koffi.load('kernel32.dll');
const security = koffi.load('advapi32.dll');
const currentProcess = kernel.func('intptr_t __stdcall GetCurrentProcess()');
const openToken = security.func('int __stdcall OpenProcessToken(intptr_t process, uint32_t access, _Out_ intptr_t *token)');
const tokenInformation = security.func('int __stdcall GetTokenInformation(intptr_t token, uint32_t kind, void *buffer, uint32_t size, _Out_ uint32_t *needed)');
const sidToString = security.func('int __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **text)');
const free = kernel.func('void * __stdcall LocalFree(void *memory)');
const createMutex = kernel.func('intptr_t __stdcall CreateMutexExW(void *attributes, str16 name, uint32_t flags, uint32_t access)');
const wait = kernel.func('uint32_t __stdcall WaitForSingleObject(intptr_t handle, uint32_t milliseconds)');
const release = kernel.func('int __stdcall ReleaseMutex(intptr_t handle)');
const close = kernel.func('int __stdcall CloseHandle(intptr_t handle)');
const lastError = kernel.func('uint32_t __stdcall GetLastError()');
const tokenUser = koffi.struct({ sid: 'void *', attributes: 'uint32_t' });

function windowsError(action: string): Error {
  return new Error(`${action} (Windows error ${lastError()}).`);
}

function currentUserSid(): string {
  const token = [0];
  if (!openToken(currentProcess(), 0x0008 /* TOKEN_QUERY */, token)) throw windowsError('Cannot open the user token');
  try {
    const needed = [0];
    tokenInformation(token[0], 1 /* TokenUser */, null, 0, needed);
    if (!needed[0]) throw windowsError('Cannot size the user identity');
    const buffer = Buffer.alloc(needed[0]);
    if (!tokenInformation(token[0], 1 /* TokenUser */, buffer, buffer.length, needed)) {
      throw windowsError('Cannot read the user identity');
    }
    const { sid } = koffi.decode(buffer, tokenUser) as { sid: unknown };
    const text: unknown[] = [null];
    if (!sidToString(sid, text)) throw windowsError('Cannot format the user identity');
    try {
      const value = koffi.decode(text[0], 'char16_t', -1) as string;
      if (!/^S-\d+(?:-\d+)+$/.test(value)) throw new Error('Windows returned an invalid user identity.');
      return value;
    } finally {
      free(text[0]);
    }
  } finally {
    close(token[0]);
  }
}

/** Hold one send per account across Windows sessions until the returned function is called. */
export function acquireSendLock(): () => void {
  const handle: number | bigint = createMutex(null, `Global\\chatgpt-cli-send-${currentUserSid()}`, 0,
    0x100000 | 0x0001 /* SYNCHRONIZE | MUTEX_MODIFY_STATE */);
  if (!handle) throw windowsError('Cannot open the send lock');
  const status: number = wait(handle, 0);
  if (status !== 0 && status !== 0x80 /* WAIT_ABANDONED */) {
    const error = status === 0x102 /* WAIT_TIMEOUT */
      ? new Error('Another chatgpt-cli send is already running; no profiles were changed.')
      : windowsError('Cannot acquire the send lock');
    close(handle);
    throw error;
  }
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const released = release(handle);
    const closed = close(handle);
    if (!released || !closed) throw new Error('Could not release the send lock.');
  };
}
