import { createHash } from 'node:crypto';
import koffi from 'koffi';

// Retain real Windows locking without contending with live sends or other test runs.
const scope = createHash('sha256').update(process.env.LOCALAPPDATA).digest('hex');
const load = koffi.load;
koffi.load = name => {
  const library = load(name);
  if (name !== 'kernel32.dll') return library;
  const func = library.func.bind(library);
  return { ...library, func(...definition) {
    const native = func(...definition);
    return definition.length === 1 && definition[0].includes('CreateMutexExW')
      ? (attributes, name, flags, access) => native(attributes, `${name}-fixture-${scope}`, flags, access)
      : native;
  } };
};
