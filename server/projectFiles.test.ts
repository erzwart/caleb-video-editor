import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ProjectState } from '../src/shared/types';
import { createToolServer, type ToolServices } from './mcp';
import { listProjectFiles, projectFile } from './projectFiles';

test('Project file tools confine writes to source and scene scope, rejecting traversal and symlinks', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storyboard-files-'));
  try {
    const p = { id: 'p', dir, scenes: [{ id: 'one' }, { id: 'two' }] } as ProjectState;
    const scope = { kind: 'scene', projectId: 'p', sceneId: 'one' } as const;
    assert.equal(await projectFile(p, scope, 'scenes/one.tsx', true), path.join(dir, 'scenes/one.tsx'));
    assert.equal(await projectFile(p, scope, 'scenes/two.tsx'), path.join(dir, 'scenes/two.tsx'));
    for (const file of ['scenes/two.tsx', 'project.json', 'art-direction.md', 'components/Card.tsx']) {
      await assert.rejects(projectFile(p, scope, file, true));
    }
    const project = { kind: 'project', projectId: 'p' } as const;
    assert.equal(await projectFile(p, project, 'components/Card.tsx', true), path.join(dir, 'components/Card.tsx'));
    for (const file of [
      '../outside.tsx',
      '/tmp/outside.tsx',
      'scenes/../project.json',
      'components/.codex/config.ts',
      'components/foo/../../evil.tsx',
      'sounds/sounds.json',
      'components/script.sh',
    ]) {
      await assert.rejects(projectFile(p, project, file, true));
    }
    await assert.rejects(projectFile(p, { ...project, projectId: 'other' }, 'art-direction.md'));
    await fs.mkdir(path.join(dir, 'components'));
    await fs.writeFile(path.join(dir, 'components', 'Card.tsx'), 'content');
    await fs.symlink(path.join(dir, 'components', 'Card.tsx'), path.join(dir, 'components', 'Link.tsx'));
    await assert.rejects(projectFile(p, project, 'components/Link.tsx'));
    await assert.rejects(projectFile(p, project, 'components/Link.tsx', true));
    assert.ok(!(await listProjectFiles(p, scope)).includes('components/Link.tsx'));
    await fs.symlink(os.tmpdir(), path.join(dir, 'components', 'linked'));
    await assert.rejects(projectFile(p, project, 'components/linked/outside.tsx', true));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('MCP file calls update the preview and enforce scene and project boundaries', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storyboard-mcp-files-'));
  const p = { id: 'p', dir, scenes: [{ id: 'one' }, { id: 'two' }] } as ProjectState;
  let syncs = 0;
  let changes = 0;
  const services = {
    store: {
      get: async () => p,
      syncCode: async () => {
        syncs++;
      },
      changed: () => {
        changes++;
      },
    },
    engine: { isReady: () => false },
    sfx: { isReady: () => false },
  } as unknown as ToolServices;
  const server = createToolServer(services, { kind: 'scene', projectId: 'p', sceneId: 'one' });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const write = await client.callTool({
      name: 'write_project_file',
      arguments: { file: 'scenes/one.tsx', content: 'export default () => null;' },
    });
    assert.ok(!write.isError);
    assert.equal(await fs.readFile(path.join(dir, 'scenes/one.tsx'), 'utf8'), 'export default () => null;');
    assert.equal(syncs, 1);
    assert.equal(changes, 1);
    const read = await client.callTool({ name: 'read_project_file', arguments: { file: 'scenes/one.tsx' } });
    assert.ok(JSON.stringify(read.content).includes('export default'));
    const denied = await client.callTool({
      name: 'write_project_file',
      arguments: { file: 'scenes/two.tsx', content: 'forbidden' },
    });
    assert.equal(denied.isError, true);
    const other = await client.callTool({ name: 'read_project_file', arguments: { project: 'other', file: 'scenes/one.tsx' } });
    assert.equal(other.isError, true);
    assert.equal(syncs, 1);
  } finally {
    await client.close();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
