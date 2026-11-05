import type { ResolvedConfiguration } from '@vspod/config';
import type { ExtensionRuntimeAdapter } from '@vspod/extensions';
import type { Workspace } from '@vspod/workspace';
import type { ContainerRuntime, RuntimeInstance } from './runtime.ts';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { privateDirectory } from './state.ts';

export type RuntimeConfiguration = ResolvedConfiguration & { restricted?: boolean };

export type EditorPresentation =
  | { kind: 'web'; origin: string; authentication: { kind: 'password'; password: string } }
  | { kind: 'native'; sessionId: string };

export interface EditorSession {
  backend: string;
  containerId: string;
  startedAt: string;
  presentation: EditorPresentation;
}

/** Editor policy belongs here, not in the container driver or the generic app runner. */
export interface EditorBackend {
  readonly id: string;
  readonly vscodeVersion: string;
  readonly runtime: ContainerRuntime;
  readonly nativePresenter?: {
    check(): Promise<void>;
    launch(directory: string): ChildProcess;
    openFolder(workspace: Workspace, folder: string, newWindow: boolean, restricted: boolean): Promise<void>;
  };
  start(workspace: Workspace, configuration: RuntimeConfiguration): Promise<EditorSession>;
  resume(instance: RuntimeInstance, session: EditorSession | undefined): EditorSession;
  waitForReady(workspace: Workspace, session: EditorSession): Promise<void>;
  extensionAdapter?(workspace: Workspace): ExtensionRuntimeAdapter;
  diagnose?(workspace: Workspace): Promise<readonly { name: string; detail: string; healthy: boolean }[]>;
}

export async function backendStateDirectory(state: string, backend: EditorBackend): Promise<string> {
  if (!/^[a-z][a-z0-9-]*$/.test(backend.id)) throw new Error('Invalid editor backend identifier.');
  const directory = backend.id === 'desktop' ? join(state, 'desktop') : state;
  await privateDirectory(directory);
  return directory;
}
