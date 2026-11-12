const cli = new URL('../../src/main.ts', import.meta.url).href;

/** Replace only the CLI's submission timer, leaving browser and readiness timers real. */
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
    import { registerHooks } from 'node:module';
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === 'node:timers/promises' && context.parentURL === ${JSON.stringify(cli)}) {
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
