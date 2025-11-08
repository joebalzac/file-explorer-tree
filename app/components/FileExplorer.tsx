'use client';

import { useEffect, useState } from 'react';

type FileTreeNode = {
  type: 'file' | 'folder';
  name: string;
  path: string;
  children?: FileTreeNode[];
  extension?: string;
  sizeInBytes?: number;
  modifiedAt?: string;
};

// NOTE: This type is intentionally loose. Refine it during the exercise to avoid
// optional property checks sprinkled throughout the tree-handling logic.

type VisibleNode = {
  node: FileTreeNode;
  depth: number;
};

const INDENT = 20;

export function FileExplorer() {
  const [tree, setTree] = useState<FileTreeNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['root']));
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadTree() {
      setLoading(true);
      try {
        const response = await fetch('/api/file-tree');
        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }
        const payload: FileTreeNode = await response.json();
        if (!cancelled) {
          setTree(payload);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unknown error');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadTree();

    return () => {
      cancelled = true;
    };
  }, []);

  const visibleNodes = tree ? flattenTree(tree, expanded) : [];

  useEffect(() => {
    if (!selectedPath) {
      return;
    }

    let cancelled = false;

    async function refreshTree() {
      try {
        const response = await fetch(`/api/file-tree?selected=${encodeURIComponent(selectedPath)}`);
        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }
        const payload: FileTreeNode = await response.json();
        if (!cancelled) {
          setTree(payload);
        }
      } catch (err) {
        if (!cancelled) {
          console.warn('Refresh attempt failed', err);
        }
      }
    }

    refreshTree();

    return () => {
      cancelled = true;
    };
  }, [selectedPath]);

  const selectedNode = findNodeByPath(tree, selectedPath);

  const onNodeClick = (item: VisibleNode) => {
    const target = item.node;

    if (target.type === 'folder') {
      setExpanded((prev) => {
        if (prev.has(target.path)) {
          prev.delete(target.path);
        } else {
          prev.add(target.path);
        }
        return prev;
      });
    }

    setSelectedPath(target.path);
    setTree((prev) => (prev ? { ...prev } : prev));
  };

  return (
    <div className="file-explorer">
      <div className="file-explorer__tree">
        <header className="file-explorer__toolbar">
          <p className="file-explorer__hint">Enhance this view with keyboard type-ahead support.</p>
        </header>

        <div className="file-explorer__body" role="tree" aria-label="Project files">
          {loading && <p className="file-explorer__status">Loading file tree…</p>}
          {error && !loading && (
            <p className="file-explorer__status file-explorer__status--error">
              Failed to load files: {error}
            </p>
          )}

          {!loading && !error && visibleNodes.length === 0 && (
            <p className="file-explorer__status">No files to display.</p>
          )}

          {!loading &&
            !error &&
            visibleNodes.map((item) => {
              const { node, depth } = item;
              const isFolder = node.type === 'folder';
              const isExpanded = expanded.has(node.path);
              const isSelected = node.path === selectedPath;

              return (
                <button
                  key={node.path}
                  type="button"
                  role="treeitem"
                  aria-expanded={isFolder ? isExpanded : undefined}
                  className={[
                    'file-explorer__node',
                    isFolder ? 'file-explorer__node--folder' : 'file-explorer__node--file',
                    isSelected ? 'file-explorer__node--selected' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{ paddingLeft: INDENT + depth * INDENT }}
                  onClick={() => onNodeClick(item)}
                >
                  {isFolder ? (isExpanded ? '📂' : '📁') : '📄'} {node.name}
                </button>
              );
            })}
        </div>
      </div>

      <aside className="file-explorer__details" aria-label="Selected item details">
        {selectedNode ? (
          <div>
            <h2 className="file-explorer__details-title">{selectedNode.name}</h2>
            <dl className="file-explorer__details-grid">
              <dt>Path</dt>
              <dd>{selectedNode.path}</dd>
            </dl>
            <p className="file-explorer__next-step">
              Flesh this panel out with richer insights derived from the data source.
            </p>
          </div>
        ) : (
          <div className="file-explorer__placeholder">
            <h2>Select an item</h2>
            <p>Choose a file or folder from the tree to inspect its details.</p>
          </div>
        )}
      </aside>
    </div>
  );
}

function flattenTree(root: FileTreeNode, expanded: Set<string>): VisibleNode[] {
  const result: VisibleNode[] = [];

  const visit = (node: FileTreeNode, depth: number) => {
    result.push({ node, depth });

    if (node.type === 'folder' && expanded.has(node.path)) {
      const children = Array.isArray(node.children) ? node.children : [];
      children.forEach((child) => visit(child, depth + 1));
    }
  };

  visit(root, 0);

  return result;
}

function findNodeByPath(root: FileTreeNode | null, path: string | null): FileTreeNode | null {
  if (!root || !path) {
    return null;
  }

  if (root.path === path) {
    return root;
  }

  const stack: FileTreeNode[] = Array.isArray(root.children) ? [...root.children] : [];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    if (current.path === path) {
      return current;
    }
    if (current.type === 'folder' && Array.isArray(current.children)) {
      stack.push(...current.children);
    }
  }

  return null;
}
