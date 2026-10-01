import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProjectState } from '../src/shared/types';

export interface FileScope {
  kind: 'scene' | 'project' | 'open';
  projectId?: string;
  sceneId?: string;
}

/** Only scene source, shared components and art direction are writable through MCP. */
export async function projectFile(p: ProjectState, scope: FileScope, file: string, write = false): Promise<string> {
  if (scope.kind !== 'open' && scope.projectId !== p.id) throw new Error('This chat may only access its own project.');
  const parts = file.split('/');
  if (
    path.isAbsolute(file) ||
    parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.')) ||
    file.includes('\\')
  ) {
    throw new Error('Use a relative project file path without traversal or hidden files.');
  }
  const scene = p.scenes.some((s) => file === `scenes/${s.id}.tsx`);
  const component = file.startsWith('components/') && /\.(tsx?|jsx?|css)$/.test(file);
  const direction = file === 'art-direction.md';
  if (!(scene || component || direction || (!write && file === 'project.json')))
    throw new Error('File is outside the allowed project source files.');
  if (write && scope.kind === 'scene' && file !== `scenes/${scope.sceneId}.tsx`)
    throw new Error('This chat may only edit its own scene.');
  // Reject symlinks in every path segment, including links into otherwise allowed files.
  let current = p.dir;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Symbolic links are not allowed in project file tools.');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  return current;
}

export async function listProjectFiles(p: ProjectState, scope: FileScope): Promise<string[]> {
  const files = ['project.json', 'art-direction.md', ...p.scenes.map((s) => `scenes/${s.id}.tsx`)];
  async function walk(dir: string) {
    const target = await projectFile(p, scope, `${dir}/placeholder.tsx`);
    for (const entry of await fs.readdir(path.dirname(target), { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(file);
      else if (/\.(tsx?|jsx?|css)$/.test(file)) files.push(file);
    }
  }
  await walk('components');
  return files;
}
