import { PassThrough } from 'node:stream';
import type { Readable, Writable } from 'node:stream';

export interface InProcessStreamPair {
  clientReadable: Readable;
  clientWritable: Writable;
  serverReadable: Readable;
  serverWritable: Writable;
}

/** Bidirectional in-process stdio pair for unittest (client ↔ FakeAcpServer). */
export function createInProcessStreamPair(): InProcessStreamPair {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();

  return {
    clientReadable: serverToClient,
    clientWritable: clientToServer,
    serverReadable: clientToServer,
    serverWritable: serverToClient,
  };
}
