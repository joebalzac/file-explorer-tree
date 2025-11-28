'use client';

import { useEffect, useRef, useState } from 'react';

import type { TreeNode, FolderNode, FileNode } from '../../types/fileTree';

/**
 * For handling large datasets (10,000+ nodes), I'd consider:
 *
 * 1. Virtualization with react-window - only render what's visible in the viewport
 * 2. Memoizing flattenTree() and countFiles() to avoid recalculating on every render
 * 3. Lazy loading folder contents when expanded rather than loading everything upfront
 * 4. Debouncing the file watcher updates to batch rapid changes
 * 5. Tracking which nodes actually changed and only updating those instead of the whole tree
 */

type VisibleNode = {
  node: TreeNode;
  depth: number;
};

const INDENT = 20;

export function FileExplorer() {
  const [tree, setTree] = useState<FolderNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(['root'])
  );
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [lastUpdateTime, setLastUpdateTime] = useState<string | null>(null);
  const [isWatching, setIsWatching] = useState(false);

  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);

  const [typeahead, setTypeahead] = useState<string>('');
  const typeaheadTimeoutRef = useRef<number | null>(null);
  const nodeRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const treeContainerRef = useRef<HTMLDivElement>(null);
  const watcherConnectedRef = useRef(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadTree() {
      setLoading(true);
      try {
        const response = await fetch('/api/file-tree');
        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }
        const payload: FolderNode = await response.json();
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

  useEffect(() => {
    if (loading || !tree || watcherConnectedRef.current) return;

    const connectTimer = setTimeout(() => {
      console.log('🔌 Connecting to file watcher...');
      watcherConnectedRef.current = true;
      const eventSource = new EventSource('/api/file-tree/watch');
      eventSourceRef.current = eventSource;

      if (eventSource.readyState === EventSource.OPEN) {
        setIsWatching(true);
      }

      let isConnected = false;
      let reconnectAttempts = 0;
      const MAX_RECONNECT_ATTEMPTS = 5;

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'connected') {
            if (!isConnected) {
              console.log('✅ File watcher connected');
              isConnected = true;
            }
          } else if (data.type === 'update' && data.tree) {
            const newTree: FolderNode = data.tree;

            setTree((prevTree) => {
              if (!prevTree) {
                setLastUpdateTime(new Date().toLocaleTimeString());
                return newTree;
              }

              if (treesEqual(prevTree, newTree)) {
                return prevTree;
              }

              console.log(
                '🔄 File tree updated!',
                new Date().toLocaleTimeString()
              );

              setExpanded((prevExpanded) => {
                const newExpanded = new Set<string>();
                prevExpanded.forEach((path) => {
                  if (findNodeByPath(newTree, path)) {
                    newExpanded.add(path);
                  }
                });

                newExpanded.add('root');
                return newExpanded;
              });

              setSelectedPath((prevPath) => {
                if (prevPath && findNodeByPath(newTree, prevPath)) {
                  return prevPath;
                }
                return prevPath;
              });

              setLastUpdateTime(new Date().toLocaleTimeString());

              return newTree;
            });

            setIsWatching(true);
          } else if (data.type === 'error') {
            console.error('❌ File watcher error:', data.message);
          }
        } catch (err) {
          console.error('Failed to parse SSE message:', err);
        }
      };

      eventSource.onerror = () => {
        if (eventSource.readyState === EventSource.CLOSED) {
          reconnectAttempts++;
          if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            console.warn(
              '⚠️ File watcher connection failed after multiple attempts'
            );
            setIsWatching(false);
          }
        }
      };

      eventSource.onopen = () => {
        console.log('✅ File watcher connection opened');
        setIsWatching(true);
        isConnected = true;
        reconnectAttempts = 0;
      };
    }, 100);

    return () => {
      clearTimeout(connectTimer);
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
        setIsWatching(false);
      }
    };
  }, [loading]);

  const visibleNodes = tree ? flattenTree(tree, expanded) : [];

  useEffect(() => {
    if (!loading && !error && tree) {
      treeContainerRef.current?.focus();
    }
  }, [loading, error, tree]);

  useEffect(() => {
    if (!selectedPath) {
      treeContainerRef.current?.focus();
      return;
    }

    const el = nodeRefs.current[selectedPath];
    if (el) {
      el.scrollIntoView({ block: 'nearest' });
    }
    treeContainerRef.current?.focus();
  }, [selectedPath, visibleNodes]);

  const countFiles = (node: TreeNode): number => {
    if (node.type === 'file') return 1;
    return (node.children ?? []).reduce(
      (sum, child) => sum + countFiles(child),
      0
    );
  };

  const selectedNode = findNodeByPath(tree, selectedPath);

  const onNodeClick = (item: VisibleNode) => {
    const target = item.node;

    if (target.type === 'folder') {
      setExpanded((prev) => {
        const newSet = new Set(prev);
        if (prev.has(target.path)) {
          newSet.delete(target.path);
        } else {
          newSet.add(target.path);
        }
        return newSet;
      });
    }

    if (target.type === 'file') {
      if (!openTabs.includes(target.path)) {
        setOpenTabs([...openTabs, target.path]);
      }

      setActiveTab(target.path);
    }

    setSelectedPath(target.path);
    setTree((prev) => (prev ? { ...prev } : prev));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const { key, ctrlKey, metaKey, altKey } = event;

    if (key.startsWith('Arrow')) {
      event.preventDefault();
      if (visibleNodes.length === 0) return;

      const currentIndex = selectedPath
        ? visibleNodes.findIndex((item) => item.node.path === selectedPath)
        : -1;
      const normalizedIndex = currentIndex >= 0 ? currentIndex : 0;
      const current = visibleNodes[normalizedIndex];

      if (key === 'ArrowUp') {
        const prevIndex =
          normalizedIndex > 0 ? normalizedIndex - 1 : visibleNodes.length - 1;
        setSelectedPath(visibleNodes[prevIndex].node.path);
        return;
      }

      if (key === 'ArrowDown') {
        const nextIndex =
          normalizedIndex < visibleNodes.length - 1 ? normalizedIndex + 1 : 0;
        setSelectedPath(visibleNodes[nextIndex].node.path);
        return;
      }

      if (current?.node.type === 'folder') {
        if (key === 'ArrowRight' && !expanded.has(current.node.path)) {
          setExpanded((prev) => new Set(prev).add(current.node.path));
        }
        if (key === 'ArrowLeft' && expanded.has(current.node.path)) {
          setExpanded((prev) => {
            const next = new Set(prev);
            next.delete(current.node.path);
            return next;
          });
        }
      }
      return;
    }

    if (key.length !== 1 || ctrlKey || metaKey || altKey) return;

    event.preventDefault();
    const nextQuery = (typeahead + key).toLowerCase();

    if (typeaheadTimeoutRef.current !== null) {
      window.clearTimeout(typeaheadTimeoutRef.current);
    }
    typeaheadTimeoutRef.current = window.setTimeout(() => {
      setTypeahead('');
      typeaheadTimeoutRef.current = null;
    }, 400);

    setTypeahead(nextQuery);

    const startIndex = selectedPath
      ? visibleNodes.findIndex((item) => item.node.path === selectedPath)
      : -1;

    const ordered = [
      ...visibleNodes.slice(startIndex + 1),
      ...visibleNodes.slice(0, startIndex + 1),
    ];

    const match = ordered.find((item) =>
      item.node.name.toLowerCase().startsWith(nextQuery)
    );

    if (match) {
      setSelectedPath(match.node.path);
    }
  };

  return (
    <div className="file-explorer">
      <div className="file-explorer__tree">
        <header className="file-explorer__toolbar">
          <p className="file-explorer__hint">
            Enhance this view with keyboard type-ahead support.
          </p>
          <div className="file-explorer__watcher-status">
            <span
              className={`file-explorer__watcher-indicator ${
                isWatching ? 'file-explorer__watcher-indicator--active' : ''
              }`}
            />
            <span>
              {isWatching ? 'Watching for changes' : 'Not watching'}
              {lastUpdateTime && (
                <span className="file-explorer__watcher-time">
                  {' • '}Last update: {lastUpdateTime}
                </span>
              )}
            </span>
          </div>
        </header>

        <div
          ref={treeContainerRef}
          className="file-explorer__body"
          role="tree"
          aria-label="Project files"
          tabIndex={0}
          onKeyDown={handleKeyDown}
        >
          {loading && (
            <p className="file-explorer__status">Loading file tree…</p>
          )}
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
              const fileTotal = countFiles(node);
              const isFolder = node.type === 'folder';
              const isExpanded = expanded.has(node.path);
              const isSelected = node.path === selectedPath;

              return (
                <div key={node.path} className="file-explorer__node--wrapper">
                  <button
                    type="button"
                    role="treeitem"
                    aria-expanded={isFolder ? isExpanded : undefined}
                    className={[
                      'file-explorer__node',
                      isFolder
                        ? 'file-explorer__node--folder'
                        : 'file-explorer__node--file',
                      isSelected ? 'file-explorer__node--selected' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    style={{ paddingLeft: INDENT + depth * INDENT }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onNodeClick(item);
                    }}
                    tabIndex={-1}
                    ref={(el) => {
                      if (el) {
                        nodeRefs.current[node.path] = el;
                      } else {
                        delete nodeRefs.current[node.path];
                      }
                    }}
                  >
                    <span>
                      {isFolder ? (isExpanded ? '📂' : '📁') : '📄'} {node.name}
                    </span>
                    <span className="file-explorer__badge">{fileTotal}</span>
                  </button>
                </div>
              );
            })}
        </div>
      </div>

      <aside
        className="file-explorer__details"
        aria-label="Selected item details"
      >
        {openTabs.length > 0 && (
          <div
            style={{
              display: 'flex',
              borderBottom: '1px solid var(--border)',
              marginBottom: '1rem',
            }}
          >
            {openTabs.map((path) => {
              const tabNode = findNodeByPath(tree, path);
              return (
                <button
                  key={path}
                  onClick={() => setActiveTab(path)}
                  style={{
                    padding: '0.5rem 1rem',
                    border: 'none',
                    background:
                      path === activeTab
                        ? 'var(--surface-accent)'
                        : 'transparent',
                    borderBottom:
                      path === activeTab ? '2px solid var(--accent)' : 'none',
                    cursor: 'pointer',
                    color:
                      path === activeTab
                        ? 'var(--text)'
                        : 'var(--muted), var(--italicized)',
                    fontStyle: path === activeTab ? 'normal' : 'italic',
                  }}
                >
                  {tabNode?.name}
                </button>
              );
            })}
          </div>
        )}

        {activeTab ? (
          (() => {
            const node = findNodeByPath(tree, activeTab);
            return node ? (
              <div>
                <h2 className="file-explorer__details-title">{node.name}</h2>
                <dl className="file-explorer__details-grid">
                  <dt>Path</dt>
                  <dd>{node.path}</dd>
                </dl>
                <p className="file-explorer__next-step">
                  Flesh this panel out with richer insights derived from the
                  data source.
                </p>
              </div>
            ) : null;
          })()
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

function flattenTree(root: FolderNode, expanded: Set<string>): VisibleNode[] {
  const result: VisibleNode[] = [];

  const visit = (node: TreeNode, depth: number) => {
    result.push({ node, depth });

    if (node.type === 'folder' && expanded.has(node.path)) {
      node.children.forEach((child) => visit(child, depth + 1));
    }
  };

  visit(root, 0);

  return result;
}

function findNodeByPath(
  root: FolderNode | null,
  path: string | null
): TreeNode | null {
  if (!root || !path) {
    return null;
  }

  if (root.path === path) {
    return root;
  }

  const stack: TreeNode[] = root ? [...root.children] : [];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    if (current.path === path) {
      return current;
    }
    if (current.type === 'folder') {
      stack.push(...current.children);
    }
  }

  return null;
}

function treesEqual(a: FolderNode, b: FolderNode): boolean {
  if (a.path !== b.path || a.name !== b.name) {
    return false;
  }

  if (a.children.length !== b.children.length) {
    return false;
  }

  const aChildren = [...a.children].sort((x, y) =>
    x.path.localeCompare(y.path)
  );
  const bChildren = [...b.children].sort((x, y) =>
    x.path.localeCompare(y.path)
  );

  for (let i = 0; i < aChildren.length; i++) {
    const aChild = aChildren[i];
    const bChild = bChildren[i];

    if (aChild.path !== bChild.path || aChild.name !== bChild.name) {
      return false;
    }

    if (aChild.type === 'folder' && bChild.type === 'folder') {
      if (!treesEqual(aChild, bChild)) {
        return false;
      }
    }
  }

  return true;
}
