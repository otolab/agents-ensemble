/** JSON value used by conductor tool schemas and structured results. */
export type ConductorJsonValue =
  | string
  | number
  | boolean
  | null
  | ConductorJsonValue[]
  | { [key: string]: ConductorJsonValue };

/** JSON Schema for a conductor tool's arguments. */
export type ConductorToolInputSchema = Record<string, ConductorJsonValue>;

export interface ConductorToolTextContent {
  type: 'text';
  text: string;
}

export interface ConductorToolResult {
  content: ConductorToolTextContent[];
  structuredContent?: Record<string, ConductorJsonValue>;
}

export type ConductorToolExecute = (
  args: Record<string, ConductorJsonValue>,
) => Promise<ConductorToolResult>;

/** Backend-neutral representation of a harness tool exposed to the conductor. */
export interface ConductorTool {
  name: string;
  description: string;
  inputSchema: ConductorToolInputSchema;
  execute: ConductorToolExecute;
}

export type ConductorToolSet = Record<string, ConductorTool>;

export class ConductorToolRegistry {
  private readonly tools = new Map<string, ConductorTool>();

  constructor(
    tools?: Iterable<ConductorTool> | ConductorToolSet,
  ) {
    if (tools) {
      this.registerAll(tools);
    }
  }

  register(tool: ConductorTool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  registerAll(
    tools: Iterable<ConductorTool> | ConductorToolSet,
  ): this {
    if (Symbol.iterator in Object(tools)) {
      for (const tool of tools as Iterable<ConductorTool>) {
        this.register(tool);
      }
    } else {
      for (const tool of Object.values(tools as ConductorToolSet)) {
        this.register(tool);
      }
    }
    return this;
  }

  get(name: string): ConductorTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ConductorTool[] {
    return [...this.tools.values()];
  }

  get size(): number {
    return this.tools.size;
  }

  toRecord(): ConductorToolSet {
    return Object.fromEntries(this.tools.entries());
  }
}
