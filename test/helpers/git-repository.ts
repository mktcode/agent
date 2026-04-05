import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { simpleGit } from 'simple-git';

export interface TestGitRepository {
  cleanup: () => Promise<void>;
  fileContent: string;
  filePath: string;
  repoPath: string;
}

export async function createGitRepository(): Promise<TestGitRepository> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'nextagent-repo-'));
  const repoPath = path.join(rootPath, 'remote');
  await mkdir(repoPath, { recursive: true });

  const repositoryGit = simpleGit(repoPath);
  await repositoryGit.init();
  await repositoryGit.addConfig('user.name', 'Nextagent Test');
  await repositoryGit.addConfig('user.email', 'test@example.com');

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