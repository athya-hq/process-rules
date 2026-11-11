import { run } from './run.ts';
import { realSys } from './sys.ts';

/** Runs the command line given, and sets the exit code. */
export async function main(): Promise<void> {
  process.exitCode = await run(
    process.argv.slice(2),
    {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    },
    realSys,
  );
}
