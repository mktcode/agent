import { access } from 'node:fs/promises';

import { simpleGit } from 'simple-git';

import { InvalidLockStateError, LockUnavailableError } from './errors';

export { InvalidLockStateError, LockUnavailableError } from './errors';

export interface WorkspaceManagerOptions {
  repoUrl: string;
  workspacePath: string;
}

export class WorkspaceManager {
  readonly #repoUrl: string;
  readonly #workspacePath: string;
  #locked = false;

  public constructor(options: WorkspaceManagerOptions) {
    this.#repoUrl = options.repoUrl;
    this.#workspacePath = options.workspacePath;
  }

  public async initialize(): Promise<void> {
    if (await this.#workspaceExists()) {
      return;
    }

    await simpleGit().clone(this.#repoUrl, this.#workspacePath);
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
}