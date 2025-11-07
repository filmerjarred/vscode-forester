/**
 * get-forest.ts - Forest caching and management layer
 *
 * This module manages the cached forest data and provides high-level functions
 * for accessing tree information with automatic caching and file watching.
 */

import * as vscode from "vscode";
import { queryForest, Forest, ForesterTree } from "./server";
import { getRoot } from "./utils";
import { readFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";

// Re-export types from server for convenience
export type { Forest, ForesterTree } from "./server";

// For managing the global cache flow
let queryInProgressPromise: Promise<Forest> | null = null;
let mostRecentQueryResult: Forest | null = null;
let isInitialLoad = true;

// File event handlers and callbacks
let fileEventDisposables: vscode.Disposable[] = [];
const forestChangeCallbacks = new Set<() => void>();

export async function getTree(treeId: string): Promise<ForesterTree | null> {
   // if we can find it in our most recent successful query just return (keeps things fast)
   if (mostRecentQueryResult) {
      let tree = mostRecentQueryResult.find((entry) => entry.uri === treeId);
      if (tree) return tree
   }

   const forest = await getForest();
   return forest.find((entry) => entry.uri === treeId) || null;
}

// await to return a forest array, handles all the caching logic
export async function getForest({ forceReload, fastReturnStale }: { forceReload?: boolean, fastReturnStale?: boolean } = {}): Promise<Forest> {
   // If there's no query in progress (or we don't care that the data might be stale) and we have some then return it (unless we're forcing a reload). A reload is forced whenever a file changes by forestUpdatedOnDisk.
   if ((!queryInProgressPromise || fastReturnStale) && mostRecentQueryResult && !forceReload) return mostRecentQueryResult

   // If we have a query in progress then return the promise which will resolve to result
   if (queryInProgressPromise && !forceReload) return queryInProgressPromise

   // Show starting notification (only for initial load)
   if (isInitialLoad) {
      vscode.window.showInformationMessage("🌲 Forester: Building forest cache...");
   }

   queryInProgressPromise = queryForestWithFallback()

   // setting the global promise and then awaiting means that if there are calls to getForest in the meantime they will await the same promise
   const result = mostRecentQueryResult = await queryInProgressPromise

   forestChangeCallbacks.forEach(callback => {
      try {
         callback();
      } catch (error) {
         console.error('Error in forest change callback:', error);
      }
   });

   // Show completion notification (only for initial load)
   if (isInitialLoad) {
      vscode.window.showInformationMessage(`✅ Forester: Loaded ${result.length} trees`);
      isInitialLoad = false;
   }

   queryInProgressPromise = null

   return mostRecentQueryResult || []
}

/**
 * Query the forest with fallback to build output
 */
async function queryForestWithFallback(): Promise<Forest> {
   const result = await queryForest();

   // If query succeeded, return the result
   if (result.length > 0) {
      return result;
   }

   // If query failed, try to fall back to most recent in-memory success
   if (mostRecentQueryResult) {
      return mostRecentQueryResult;
   }

   // If that doesn't work, try to get data from the most recent successful build
   const buildData = await getForestFromBuild();
   if (buildData) {
      return buildData;
   }

   // If nothing works, return empty array
   return [];
}

/**
 * Initialize forest monitoring - starts watching for file changes
 */
export function initForestMonitoring(context: vscode.ExtensionContext) {
   // Clean up any existing handlers
   fileEventDisposables.forEach(d => d.dispose());
   fileEventDisposables = [];

   const forestUpdatedOnDisk = async () => {
      // if the query takes 4s, and we call this a bunch of times in that time
      // then the first one will create the promise, and then rest will await it
      // and then when it's done whoever awaited first will re-do it
      if (queryInProgressPromise) await queryInProgressPromise

      await getForest({ forceReload: true })
   }

   // Watch for .tree file changes using workspace events (more reliable than createFileSystemWatcher)
   fileEventDisposables.push(
      // Save events catch changes made in VS Code
      vscode.workspace.onDidSaveTextDocument((doc) => {
         if (doc.fileName.endsWith('.tree') || doc.fileName.endsWith('forest.toml')) {
            forestUpdatedOnDisk();
         }
      }),

      // File creation events
      vscode.workspace.onDidCreateFiles((event) => {
         if (event.files.some(uri => uri.fsPath.endsWith('.tree') || uri.fsPath.endsWith('forest.toml'))) {
            forestUpdatedOnDisk();
         }
      }),

      // File deletion events
      vscode.workspace.onDidDeleteFiles((event) => {
         if (event.files.some(uri => uri.fsPath.endsWith('.tree') || uri.fsPath.endsWith('forest.toml'))) {
            forestUpdatedOnDisk();
         }
      }),

      // File rename events
      vscode.workspace.onDidRenameFiles((event) => {
         if (event.files.some(f => f.oldUri.fsPath.endsWith('.tree') || f.newUri.fsPath.endsWith('.tree') ||
            f.oldUri.fsPath.endsWith('forest.toml') || f.newUri.fsPath.endsWith('forest.toml'))) {
            forestUpdatedOnDisk();
         }
      })
   );

   // Add to subscriptions for cleanup
   context.subscriptions.push(...fileEventDisposables);

   // Trigger initial load
   getForest({ forceReload: true })
}


/**
 * Register a callback to be called when the forest changes
 * Returns a disposable to unregister the callback
 */
export function onForestChange(callback: () => void): vscode.Disposable {
   forestChangeCallbacks.add(callback);

   // If we already have cached results, call the callback immediately
   if (mostRecentQueryResult) {
      callback();
   }

   return new vscode.Disposable(() => {
      forestChangeCallbacks.delete(callback);
   });
}


/**
 * Cleanup function for extension deactivation
 */
export function cleanupServer(): void {
   // Dispose file event handlers
   fileEventDisposables.forEach(d => d.dispose());
   fileEventDisposables = [];

   // Clear callbacks
   forestChangeCallbacks.clear();

   // Clear cache
   queryInProgressPromise = null;
   mostRecentQueryResult = null;
}

/**
 * Read forest.json from the output directory
 * This provides an alternative way to get the forest data from the built output
 * The structure matches ForesterTree[] exactly
 */
export async function getForestFromBuild(): Promise<Forest | null> {
   try {
      const root = getRoot();
      const outputPath = join(root.fsPath, "output", "forest.json");

      if (!existsSync(outputPath)) return null

      const content = await readFile(outputPath, "utf-8");
      const data = JSON.parse(content) as Forest;

      // Validate that it's an array of ForesterTree objects
      if (!Array.isArray(data)) {
         console.error("forest.json is not an array");
         return null;
      }

      // Basic validation of the structure
      for (const tree of data) {
         if (typeof tree.uri !== "string") {
            console.error("Invalid tree structure in forest.json: missing uri");
            return null;
         }
      }

      return data;
   } catch (error) {
      console.error("Failed to read forest.json from output:", error);
      return null;
   }
}
