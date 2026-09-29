import { JsonlSessionRepo, NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import type { AgentMessage, Session } from '@earendil-works/pi-agent-core/node';

/** Project-local Pi transcript storage used by the conductor backend. */
export const PI_SESSION_ROOT = '.ensemble/pi/sessions';

/**
 * The Pi Agent Core `Agent` keeps its transcript in memory. This small adapter
 * persists the same messages through Pi's JSONL session API so a new process
 * can rebuild `Agent.state.messages` for `--resume`.
 */
export class PiConductorSession {
  private persistedMessages: AgentMessage[];
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly session: Session,
    messages: AgentMessage[],
  ) {
    this.persistedMessages = [...messages];
  }

  static async create(cwd: string, sessionId: string): Promise<PiConductorSession> {
    const repo = createSessionRepo(cwd);
    const session = await repo.create({ cwd, id: sessionId });
    return new PiConductorSession(session, []);
  }

  static async resume(cwd: string, sessionId: string): Promise<PiConductorSession> {
    const repo = createSessionRepo(cwd);
    const metadata = (await repo.list({ cwd })).find(
      (candidate) => candidate.id === sessionId,
    );
    if (!metadata) {
      throw new Error(
        `Pi session not found for resume (sessionId=${sessionId}, cwd=${cwd}, ` +
          `sessionsRoot=${PI_SESSION_ROOT})`,
      );
    }

    const session = await repo.open(metadata);
    const context = await session.buildContext();
    return new PiConductorSession(session, context.messages);
  }

  get messages(): readonly AgentMessage[] {
    return this.persistedMessages;
  }

  /** Append only the suffix not already written to the JSONL transcript. */
  async appendNewMessages(messages: readonly AgentMessage[]): Promise<void> {
    const write = this.writeQueue.then(async () => {
      const newMessages = messages.slice(this.persistedMessages.length);
      for (const message of newMessages) {
        await this.session.appendMessage(message);
      }
      if (newMessages.length > 0) {
        this.persistedMessages = [
          ...this.persistedMessages,
          ...newMessages,
        ];
      }
    });
    this.writeQueue = write.catch(() => {});
    await write;
  }
}

function createSessionRepo(cwd: string): JsonlSessionRepo {
  return new JsonlSessionRepo({
    fs: new NodeExecutionEnv({ cwd }),
    sessionsRoot: PI_SESSION_ROOT,
  });
}
