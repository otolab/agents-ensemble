import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function runGh(
  args: string[],
  options: { cwd?: string } = {},
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gh', args, {
      cwd: options.cwd,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    const detail = err.stderr?.trim() || err.message;
    throw new Error(`gh ${args.join(' ')} failed: ${detail}`);
  }
}
