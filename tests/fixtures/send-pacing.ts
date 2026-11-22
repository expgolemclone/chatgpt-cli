const send = new URL('../../src/send.ts', import.meta.url).href;

/** Control submission pacing and collect persisted log events alongside fixture events. */
export function sendPacingFixture(realDelays: number[] = []): string {
  const source = `
    import { setTimeout as wait } from 'node:timers/promises';
    const realDelays = new Set(${JSON.stringify(realDelays)});
    let calls = 0;
    export async function setTimeout(delay) {
      const real = realDelays.has(++calls);
      console.log(JSON.stringify({ event: 'fixture-send-delay', delay, time: Date.now(), real }));
      if (real) await wait(delay);
    }
  `;
  return `
    import sendFs from 'node:fs';
    import { registerHooks, syncBuiltinESMExports as syncSendFs } from 'node:module';
    const append = sendFs.appendFileSync;
    sendFs.appendFileSync = (file, data, ...args) => {
      append(file, data, ...args);
      if (String(file).endsWith('.jsonl')) process.stdout.write(data);
    };
    syncSendFs();
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === 'node:timers/promises' && context.parentURL === ${JSON.stringify(send)}) {
          return { url: 'fixture:send-pacing', shortCircuit: true };
        }
        return nextResolve(specifier, context);
      },
      load(url, context, nextLoad) {
        if (url === 'fixture:send-pacing') {
          return { format: 'module', source: ${JSON.stringify(source)}, shortCircuit: true };
        }
        return nextLoad(url, context);
      },
    });
  `;
}
