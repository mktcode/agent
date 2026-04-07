import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';

import { simpleGit } from 'simple-git';

import {
  InvalidLockStateError,
  LockUnavailableError,
  PostCloneCommandError,
  toErrorDetails,
} from './errors';

export { InvalidLockStateError, LockUnavailableError, PostCloneCommandError } from './errors';

export interface WorkspaceManagerOptions {
  postCloneCommand?: string;
  repoUrl: string;
  workspacePath: string;
}

export class WorkspaceManager {
  readonly #postCloneCommand?: string;
  readonly #repoUrl: string;
  readonly #workspacePath: string;
  #locked = false;

  public constructor(options: WorkspaceManagerOptions) {
    this.#postCloneCommand = options.postCloneCommand;
    this.#repoUrl = options.repoUrl;
    this.#workspacePath = options.workspacePath;
  }

  public async initialize(): Promise<void> {
    if (await this.#workspaceExists()) {
      return;
    }

    await simpleGit().clone(this.#repoUrl, this.#workspacePath);

    if (this.#postCloneCommand !== undefined) {
      await this.#runPostCloneCommand();
    }
  }

  public acquire(): boolean {
    if (this.#locked) {
      return false;
    }

    this.#locked = true;
    return true;
  }

  public release(): void {
    if (!this.#locked) {
      throw new InvalidLockStateError();
    }

    this.#locked = false;
  }

  public isLocked(): boolean {
    return this.#locked;
  }

  public async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.acquire()) {
      throw new LockUnavailableError();
    }

    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  async #workspaceExists(): Promise<boolean> {
    try {
      await access(this.#workspacePath);
      return true;
    } catch {
      return false;
    }
  }

  async #runPostCloneCommand(): Promise<void> {
    const command = this.#postCloneCommand;

    if (command === undefined) {
      return;
    }

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(command, {
          cwd: this.#workspacePath,
          env: process.env,
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk: Buffer | string) => {
          stdout += chunk.toString();
        });

        child.stderr.on('data', (chunk: Buffer | string) => {
          stderr += chunk.toString();
        });

        child.on('error', (error) => {
          reject(new PostCloneCommandError(command, {
            cause: toErrorDetails(error),
            stderr,
            stdout,
          }));
        });

        child.on('close', (code) => {
          resolve({ code, stdout, stderr });
        });
      },
    );

    if (result.code !== 0) {
      throw new PostCloneCommandError(command, {
        exitCode: result.code,
        stderr: result.stderr,
        stdout: result.stdout,
      });
    }
  }
}