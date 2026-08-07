import { afterEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import {
  cleanupMaterializedGoalDraft,
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

    await cleanupMaterializedGoalDraft(draft.outputDir);

    await expect(fs.stat(draft.outputDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

});
