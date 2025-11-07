/**
 * utils.ts - Common utilities for the Forester extension
 */

import * as vscode from "vscode";
import { readFile, access, constants } from "fs/promises";
import { join } from "path";
import { load } from "js-toml";

/**
 * TypeScript interface for forest.toml configuration
 * Based on Forester OCaml types in lib/core/Config.ml
 */
export interface ForestConfig {
   forest?: {
      trees?: string[];
      assets?: string[];
      prefixes?: string[];
      url?: string;
      home?: string;

      /** Import trees from external forests */
      foreign?: Array<{
         path: string;
         route_locally?: boolean;
      }>;
   };
}

/**
 * Get the root workspace folder.
 * Throws an error if no workspace is open or if opening a single file.
 */
export function getRoot(): vscode.Uri {
   if (vscode.workspace.workspaceFolders?.length) {
      if (vscode.workspace.workspaceFolders.length !== 1) {
         vscode.window.showWarningMessage(
            "vscode-forester only supports opening one workspace folder.",
         );
      }
      return vscode.workspace.workspaceFolders[0].uri;
   } else {
      // Probably opened a single file
      throw new vscode.FileSystemError(
         "vscode-forester doesn't support opening a single file.",
      );
   }
}

export async function getForestConfig(): Promise<ForestConfig | null> {
   const root = getRoot();
   const config = vscode.workspace.getConfiguration("forester");
   let configFile = config.get<string>("config") || "forest.toml";

   const configPath = join(root.fsPath, configFile);
   const content = await readFile(configPath, "utf-8");

   return load(content)
}

/**
 * Get the trees directories from forest.toml config
 */
export async function getTreesDirectories(): Promise<string[]> {
   try {
      const config = await getForestConfig()
      return config?.forest?.trees || ["trees"]; // Default to ["trees"] if not specified
   } catch (error) {
      console.error("Failed to read forest.toml, defaulting to 'trees' directory:", error);
      return ["trees"];
   }
}

/**
 * Get the root trees directory for creating new trees
 */
export async function getRootTreeDirectory(): Promise<vscode.Uri> {
   const root = getRoot();
   const dirs = await getTreesDirectories();
   // Use the first directory as the root one
   return vscode.Uri.joinPath(root, dirs[0]);
}

/**
 * Get available templates from the templates directory
 * @returns Array of template names (without .tree extension), plus "(No template)" option
 */
export async function getAvailableTemplates(): Promise<string[]> {
   const root = getRoot();
   let templates: string[] = [];

   try {
      const templateFiles = await vscode.workspace.fs.readDirectory(
         vscode.Uri.joinPath(root, 'templates')
      );
      templates = templateFiles
         .filter(([n, f]) => f === vscode.FileType.File && n.endsWith(".tree"))
         .map(([n, f]) => n.slice(0, -5));
   } catch {
      // templates directory doesn't exist, return empty array
   }

   templates.push("(No template)");
   return templates;
}

/**
 * Get the template for new trees, checking default first, then prompting if needed
 * @returns Template name, undefined if no template selected, or undefined if cancelled
 */
export async function getTemplate(): Promise<string | undefined> {
   const extensionConfig = vscode.workspace.getConfiguration("forester");
   const defaultTemplate = extensionConfig.get<string>('defaultTemplate');

   // If default template is set, use it
   if (defaultTemplate) {
      return defaultTemplate !== "(No template)" ? defaultTemplate : undefined;
   }

   // Otherwise prompt for template
   const templates = await getAvailableTemplates();

   const template = await vscode.window.showQuickPick(templates, {
      canPickMany: false,
      placeHolder: "Choose a template or Escape to cancel",
      title: "Choose template"
   });

   if (template === undefined) {
      return undefined;  // Cancelled
   } else if (template === "(No template)") {
      return undefined;  // No template
   }

   return template;
}

/**
 * Get the prefix for new trees from config, or prompt if not set
 */
export async function getPrefix(): Promise<string | undefined> {
   // Get prefixes from configuration
   const extensionConfig = vscode.workspace.getConfiguration("forester")

   const defaultPrefix = extensionConfig.get<string>('defaultPrefix')
   if (defaultPrefix) return defaultPrefix

   const configToml = await getForestConfig()
   const prefixes = configToml?.forest?.prefixes;

   let prefix: string | undefined;
   if (prefixes) {
      prefix = await vscode.window.showQuickPick(prefixes, {
         canPickMany: false,
         placeHolder: "Choose prefix or Escape to use a new one (run the \"set default prefix\" command if you always use the same prefix)",
         title: "Choose prefix"
      });
   }

   if (!prefix) {
      prefix = await vscode.window.showInputBox({
         placeHolder: "Enter a prefix or Escape to cancel (run the \"set default prefix\" command if you always use the same prefix)",
         title: "Enter prefix"
      });
   }

   return prefix;
}
