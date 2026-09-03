import type { Readable } from 'node:stream';
import { NdJsonLineBuffer } from './json-rpc.js';

export interface WorkerProcessStdioLine {
  stream: 'stderr' | 'stdout';
  line: string;
  workerName?: string;
  cwd?: string;
}

export type WorkerProcessStdioLineHandler = (event: WorkerProcessStdioLine) => void;

export interface AttachChildProcessStreamCaptureOptions {
  workerName?: string;
  cwd?: string;
  onLine?: WorkerProcessStdioLineHandler;
}

export interface ChildProcessStderrCapture {
  /** 子プロセス終了後も pipe に残った stderr を読み切る。 */
  drainStderr: () => Promise<void>;
}

/** 子プロセスの stderr を行単位で読み、ハンドラへ渡す。 */
export function attachChildProcessStderrCapture(
  stderr: Readable,
  options: AttachChildProcessStreamCaptureOptions,
): ChildProcessStderrCapture {
  const buffer = new NdJsonLineBuffer();

  const emitLines = (lines: string[]) => {
    if (!options.onLine) return;
    for (const line of lines) {
      options.onLine({
        stream: 'stderr',
        line,
        workerName: options.workerName,
        cwd: options.cwd,
      });
    }
  };

  stderr.on('data', (chunk: Buffer | string) => {
    emitLines(buffer.push(String(chunk)));
  });

  stderr.on('end', () => {
    emitLines(buffer.flush());
  });

  // 速く終了する子プロセスは listener 登録前に stderr を書き終えることがある。
  stderr.resume();
  let pending: Buffer | string | null;
  while ((pending = stderr.read()) !== null) {
    emitLines(buffer.push(String(pending)));
  }

  const drainStderr = (): Promise<void> => {
    let chunk: Buffer | string | null;
    while ((chunk = stderr.read()) !== null) {
      emitLines(buffer.push(String(chunk)));
    }

    if (stderr.readableEnded) {
      emitLines(buffer.flush());
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const finish = () => {
        emitLines(buffer.flush());
        resolve();
      };
      stderr.once('end', finish);
      stderr.once('close', finish);
    });
  };

  return { drainStderr };
}
