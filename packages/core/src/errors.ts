import { ConfigurationError } from '@vspod/config';

export class VspodError extends Error {
  constructor(public readonly code: string, message: string, public readonly hint: string) {
    super(message);
    this.name = 'VspodError';
  }
}

export function explainError(error: unknown): { title: string; hint: string; code: string } {
  if (error instanceof ConfigurationError) return { title: error.message, hint: error.hint, code: error.code };
  if (error instanceof VspodError) return { title: error.message, hint: error.hint, code: error.code };
  const message = error instanceof Error ? error.message : 'Something interrupted startup.';
  if (/ENOENT|not found|missing/i.test(message)) return { title: message, hint: 'Run vspod setup to check the installation and prerequisites.', code: 'MISSING_PREREQUISITE' };
  if (/Docker|daemon/i.test(message)) return { title: message, hint: 'Open Docker Desktop, wait until it is ready, then retry. Run vspod doctor for details.', code: 'RUNTIME_UNAVAILABLE' };
  if (/Git repository/.test(message)) return { title: 'This folder is not a Git repository.', hint: 'Choose a repository with vspod open <path>, or use vspod open --recent.', code: 'NOT_A_REPOSITORY' };
  if (/session|credential/i.test(message)) return { title: message, hint: 'Run vspod stop, then vspod open to establish a fresh session. Your volumes are retained.', code: 'SESSION_UNAVAILABLE' };
  return { title: message, hint: 'Retry the command. Use vspod doctor or vspod logs for more detail.', code: 'STARTUP_FAILED' };
}
