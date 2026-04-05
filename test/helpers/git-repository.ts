import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { simpleGit, type SimpleGit } from 'simple-git';

export interface TestGitRepository {
  cleanup: () => Promise<void>;
  fileContent: string;
  filePath: string;
  repoPath: string;
}

export interface TestGitEnvironment {
  cleanup: () => Promise<void>;
  remotePath: string;
  seedPath: string;
  workspacePath: string;
}

async function configureRepository(repoPath: string): Promise<SimpleGit> {
  const git = simpleGit(repoPath);
  await git.addConfig('user.name', 'Nextagent Test');
  await git.addConfig('user.email', 'test@example.com');
  return git;
}

export async function createGitRepository(): Promise<TestGitRepository> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'nextagent-repo-'));
  const repoPath = path.join(rootPath, 'remote');
  await mkdir(repoPath, { recursive: true });

  const repositoryGit = simpleGit(repoPath);
  await repositoryGit.init();
  await configureRepository(repoPath);
  await repositoryGit.checkoutLocalBranch('main');

  const filePath = 'README.md';
  const fileContent = '# nextagent\n';

  await writeFile(path.join(repoPath, filePath), fileContent, 'utf8');
  await repositoryGit.add(filePath);
  await repositoryGit.commit('Initial commit');

  return {
    cleanup: async () => {
      await rm(rootPath, { force: true, recursive: true });
    },
    fileContent,
    filePath,
    repoPath,
  };
}

export async function createGitEnvironment(): Promise<TestGitEnvironment> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'nextagent-git-env-'));
  const remotePath = path.join(rootPath, 'remote.git');
  const seedPath = path.join(rootPath, 'seed');
  const workspacePath = path.join(rootPath, 'workspace');

  await mkdir(remotePath, { recursive: true });
  await mkdir(seedPath, { recursive: true });

  const remoteGit = simpleGit(remotePath);
  await remoteGit.init(true);

  const seedGit = simpleGit(seedPath);
  await seedGit.init();
  await configureRepository(seedPath);
  await seedGit.checkoutLocalBranch('main');

  await writeFile(path.join(seedPath, 'README.md'), '# nextagent\n', 'utf8');
  await seedGit.add('README.md');
  await seedGit.commit('Initial commit');
  await seedGit.addRemote('origin', remotePath);
  await seedGit.push('origin', 'main', ['--set-upstream']);

  await remoteGit.raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await simpleGit().clone(remotePath, workspacePath);
  await configureRepository(workspacePath);

  return {
    cleanup: async () => {
      await rm(rootPath, { force: true, recursive: true });
    },
    remotePath,
    seedPath,
    workspacePath,
  };
}

export async function commitFile(
  repoPath: string,
  filePath: string,
  content: string,
  message: string,
): Promise<string> {
  const git = simpleGit(repoPath);

  await writeFile(path.join(repoPath, filePath), content, 'utf8');
  await git.add(filePath);
  await git.commit(message);

  return git.revparse('HEAD');
}