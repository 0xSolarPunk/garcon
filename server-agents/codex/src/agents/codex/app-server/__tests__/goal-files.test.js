import { afterEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import {
  cleanupMaterializedGoalObjective,
  materializeGoalDraft,
} from '../goal-files.ts';

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('Codex goal files', () => {
  it('removes materialized video files after their goal stops owning them', async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-goal-files-'));
    tempDirs.push(codexHome);
    const draft = await materializeGoalDraft(codexHome, 'Inspect the video', [{
      kind: 'image',
      data: `data:video/mp4;base64,${Buffer.from('video').toString('base64')}`,
      name: 'clip.mp4',
      mimeType: 'video/mp4',
    }]);

    expect(draft.outputDir).not.toBeNull();
    expect(await fs.readdir(draft.outputDir)).toEqual(['file-1.mp4']);

    await cleanupMaterializedGoalObjective(codexHome, draft.objective);

    await expect(fs.stat(draft.outputDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not remove UUID paths outside the managed attachment root', async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-goal-home-'));
    const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-external-goal-'));
    tempDirs.push(codexHome, externalRoot);
    const externalDir = path.join(externalRoot, '123e4567-e89b-42d3-a456-426614174000');
    await fs.mkdir(externalDir);

    await cleanupMaterializedGoalObjective(codexHome, `Read ${externalDir}`);

    expect(await fs.stat(externalDir)).toBeDefined();
  });

  it('does not remove an unowned managed directory mentioned in ordinary prose', async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-goal-home-'));
    tempDirs.push(codexHome);
    const unownedDir = path.join(
      codexHome,
      'attachments',
      '123e4567-e89b-42d3-a456-426614174000',
    );
    await fs.mkdir(unownedDir, { recursive: true });

    await cleanupMaterializedGoalObjective(codexHome, `Do not delete ${unownedDir}`);

    expect(await fs.stat(unownedDir)).toBeDefined();
  });
});
