import { spawn } from 'node:child_process';
import { IdentityError } from './errors.ts';

export interface SecureStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

type HelperRequest =
  | { operation: 'get'; account: string }
  | { operation: 'set'; account: string; value: string }
  | { operation: 'delete'; account: string };

interface HelperResponse {
  ok: boolean;
  value?: string;
  found?: boolean;
}

export class MacKeychainSecureStore implements SecureStore {
  constructor(private readonly helperPath: string) {}

  async get(key: string): Promise<string | undefined> {
    const response = await this.request({ operation: 'get', account: validKey(key) });
    return response.found ? response.value : undefined;
  }

  async set(key: string, value: string): Promise<void> {
    await this.request({ operation: 'set', account: validKey(key), value });
  }

  async delete(key: string): Promise<void> {
    await this.request({ operation: 'delete', account: validKey(key) });
  }

  private request(request: HelperRequest): Promise<HelperResponse> {
    return new Promise((resolve, reject) => {
      let output = '';
      let failed = false;
      const child = spawn(this.helperPath, [], { stdio: ['pipe', 'pipe', 'ignore'] });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        if (output.length > 64 * 1024) {
          failed = true;
          child.kill();
        }
      });
      child.on('error', () => reject(new IdentityError('SECURE_STORE_UNAVAILABLE')));
      child.on('close', (code) => {
        if (failed || code !== 0) {
          reject(new IdentityError('SECURE_STORE_UNAVAILABLE'));
          return;
        }
        try {
          const response = JSON.parse(output) as HelperResponse;
          if (!response.ok) throw new Error();
          resolve(response);
        } catch {
          reject(new IdentityError('SECURE_STORE_UNAVAILABLE'));
        }
      });
      child.stdin.on('error', () => {
        failed = true;
      });
      child.stdin.end(JSON.stringify(request));
    });
  }
}

function validKey(key: string): string {
  if (!/^[a-zA-Z0-9._:@-]{1,200}$/.test(key)) throw new IdentityError('INVALID_CONFIGURATION');
  return key;
}
