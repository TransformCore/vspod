import type { Workspace } from '@vspod/workspace';
import type { ResolvedConfiguration } from '@vspod/config';
import type { ExtensionRuntimeAdapter } from '@vspod/extensions';
export type RuntimeConfiguration = ResolvedConfiguration & { restricted?: boolean };

export interface RuntimeInstance {
  id: string;
  running: boolean;
  startedAt?: string;
  compatible?: boolean;
  image?: string;
  url?: string;
}

export interface ContainerRuntime {
  ensureAvailable(startProvider?: boolean): Promise<void>;
  ensureImage(options?: { rebuild?: boolean }): Promise<void>;
  inspect(workspace: Workspace): Promise<RuntimeInstance | undefined>;
  create(workspace: Workspace): Promise<void>;
  start(workspace: Workspace, credential: string, configuration?: RuntimeConfiguration): Promise<RuntimeInstance>;
  stop(workspace: Workspace): Promise<void>;
  exec(workspace: Workspace, command: string[], interactive?: boolean): Promise<number>;
  logs(workspace: Workspace, follow?: boolean): Promise<number>;
  runStartupTask?(workspace: Workspace, command: string): Promise<void>;
  extensionAdapter?(workspace: Workspace): ExtensionRuntimeAdapter;
  replace(workspace: Workspace, credential: string, configuration?: RuntimeConfiguration): Promise<RuntimeInstance>;
}