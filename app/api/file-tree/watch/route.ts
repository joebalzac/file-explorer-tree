import { NextRequest } from 'next/server';
import path from 'node:path';
import { watch } from 'node:fs';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FolderNode, TreeNode } from '../../../../types/fileTree';

const execFileAsync = promisify(execFile);

const ROOT_KEY = 'root';
const SCRIPT_PATH = path.join(process.cwd(), 'scripts', 'create-file-tree.sh');
const TREE_ROOT_DIRECTORY = path.join(
  process.cwd(),
  'tmp',
  'runtime-file-tree'
);

const clients = new Set<ReadableStreamDefaultController>();

let debounceTimer: NodeJS.Timeout | null = null;
const DEBOUNCE_MS = 1000;

const encoder = new TextEncoder();

let fileWatcher: ReturnType<typeof watch> | null = null;

let lastTreeHash: string | null = null;

/**
 * SSE endpoint for real-time file tree updates.
 *
 * Decision: Using Server-Sent Events (SSE) instead of WebSockets because:
 * - Simpler: No extra dependencies, built-in browser support (EventSource)
 * - Sufficient: One-way communication (server → client) is all we need
 * - Efficient: Lower overhead than WebSockets for this use case
 * - Reliable: Automatic reconnection handling built into EventSource
 *
 * Decision: Using Node.js fs.watch instead of chokidar because:
 * - Zero dependencies: Built into Node.js
 * - Sufficient for this use case: Works well for watching a single directory tree
 * - Simpler: No need for additional package management
 */
export async function GET(request: NextRequest) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: 'connected' })}\n\n`)
      );

      clients.add(controller);

      sendTreeUpdate(controller);

      if (!fileWatcher) {
        setupFileWatcher();
      }

      request.signal.addEventListener('abort', () => {
        clients.delete(controller);
        if (clients.size === 0 && fileWatcher) {
          fileWatcher.close();
          fileWatcher = null;
        }
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

/**
 * Sets up a file watcher on the tree directory.
 * Uses recursive watching (Node.js 20+) to watch the entire subtree.
 * This is a singleton - only one watcher is created and shared across all clients.
 */
function setupFileWatcher() {
  fs.mkdir(path.dirname(TREE_ROOT_DIRECTORY), { recursive: true })
    .then(() => {
      console.log(
        `👀 File watcher initialized, watching: ${TREE_ROOT_DIRECTORY}`
      );

      fileWatcher = watch(
        TREE_ROOT_DIRECTORY,
        { recursive: true },
        async (eventType, filename) => {
          if (!filename) return;

          console.log(`📁 File change detected: ${eventType} - ${filename}`);

          if (debounceTimer) {
            clearTimeout(debounceTimer);
          }

          debounceTimer = setTimeout(async () => {
            try {
              const tree = await readTree();

              const treeHash = JSON.stringify(createTreeHash(tree));

              if (treeHash === lastTreeHash) {
                console.log('⏭️  Tree structure unchanged, skipping update');
                return;
              }

              console.log(
                '✅ Tree structure changed, sending update to clients'
              );
              lastTreeHash = treeHash;

              const message = encoder.encode(
                `data: ${JSON.stringify({ type: 'update', tree })}\n\n`
              );

              const deadClients: ReadableStreamDefaultController[] = [];
              for (const client of Array.from(clients)) {
                try {
                  client.enqueue(message);
                } catch (e) {
                  deadClients.push(client);
                }
              }

              deadClients.forEach((client) => clients.delete(client));
            } catch (error) {
              console.error('Error processing file change:', error);
            }
          }, DEBOUNCE_MS);
        }
      );

      fileWatcher.on('error', (error) => {
        console.error('File watcher error:', error);

        if (fileWatcher) {
          try {
            fileWatcher.close();
          } catch (e) {}
          fileWatcher = null;

          setTimeout(() => {
            if (clients.size > 0) {
              console.log('🔄 Restarting file watcher after error...');
              setupFileWatcher();
            }
          }, 1000);
        }

        const errorMsg = encoder.encode(
          `data: ${JSON.stringify({
            type: 'error',
            message: error.message,
          })}\n\n`
        );
        const deadClients: ReadableStreamDefaultController[] = [];
        for (const client of Array.from(clients)) {
          try {
            client.enqueue(errorMsg);
          } catch (e) {
            deadClients.push(client);
          }
        }
        deadClients.forEach((client) => clients.delete(client));
      });
    })
    .catch((error) => {
      console.error('Failed to set up file watcher:', error);
    });
}

async function sendTreeUpdate(controller: ReadableStreamDefaultController) {
  try {
    const tree = await readTree();
    const message = encoder.encode(
      `data: ${JSON.stringify({ type: 'update', tree })}\n\n`
    );
    controller.enqueue(message);
  } catch (error) {
    console.error('Failed to send tree update:', error);
    const errorMsg = encoder.encode(
      `data: ${JSON.stringify({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to read tree',
      })}\n\n`
    );
    controller.enqueue(errorMsg);
  }
}

async function readTree(): Promise<FolderNode> {
  const stats = await fs.stat(TREE_ROOT_DIRECTORY);
  if (!stats.isDirectory()) {
    throw new Error(`Expected ${TREE_ROOT_DIRECTORY} to be a directory.`);
  }

  return {
    type: 'folder',
    name: 'generated-tree',
    path: ROOT_KEY,
    children: await readDirectoryContents(TREE_ROOT_DIRECTORY, ''),
  };
}

async function readDirectoryContents(
  absolutePath: string,
  relativePath: string
): Promise<TreeNode[]> {
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });

  const sortedEntries = entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  const nodes: TreeNode[] = [];

  for (const entry of sortedEntries) {
    if (entry.name.startsWith('.')) {
      continue;
    }

    const entryAbsolute = path.join(absolutePath, entry.name);
    const entryRelative = relativePath
      ? path.join(relativePath, entry.name)
      : entry.name;

    if (entry.isDirectory()) {
      nodes.push({
        type: 'folder',
        name: entry.name,
        path: toTreePath(entryRelative),
        children: await readDirectoryContents(entryAbsolute, entryRelative),
      });
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const stats = await fs.stat(entryAbsolute);

    nodes.push({
      type: 'file',
      name: entry.name,
      path: toTreePath(entryRelative),
      extension: extractExtension(entry.name),
      sizeInBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    });
  }

  return nodes;
}

function toTreePath(relativePath: string): string {
  if (!relativePath) {
    return ROOT_KEY;
  }

  const normalized = relativePath.split(path.sep).join('/');
  return `${ROOT_KEY}/${normalized}`;
}

function extractExtension(filename: string): string | null {
  const ext = path.extname(filename).replace('.', '');
  return ext ? ext : null;
}

function createTreeHash(node: TreeNode): {
  path: string;
  name: string;
  children?: any[];
} {
  if (node.type === 'file') {
    return { path: node.path, name: node.name };
  } else {
    return {
      path: node.path,
      name: node.name,
      children: node.children.map(createTreeHash),
    };
  }
}
