import type { Workspace } from '@vspod/workspace';
export interface RuntimeInstance {
  id: string;
  running: boolean;
  startedAt?: string;
  compatible?: boolean;
  image?: string;
  ports?: Readonly<Record<string, string>>;
}

export interface ContainerRuntime {
  ensureAvailable(startProvider?: boolean): Promise<void>;
  ensureImage(options?: { rebuild?: boolean }): Promise<void>;
  inspect(workspace: Workspace): Promise<RuntimeInstance | undefined>;
  create(workspace: Workspace): Promise<void>;
  start(workspace: Workspace): Promise<RuntimeInstance>;
  stop(workspace: Workspace): Promise<void>;
  exec(workspace: Workspace, command: string[], interactive?: boolean): Promise<number>;
  logs(workspace: Workspace, follow?: boolean): Promise<number>;
  runStartupTask?(workspace: Workspace, command: string): Promise<void>;
  replace(workspace: Workspace, activate: () => Promise<void>): Promise<RuntimeInstance>;
}