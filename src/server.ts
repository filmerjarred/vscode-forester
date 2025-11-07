/**
 * server.ts - Wrapper around the Forester executable
 *
 * This module provides functions to interact with the Forester command-line tool,
 * including querying for trees and executing commands.
 */

import * as vscode from 'vscode';
import * as util from 'util';
import * as child_process from 'child_process';
import { getRoot } from "./utils";

const execFile = util.promisify(child_process.execFile);

// See lib/render/Render_json.ml in forester
export interface ForesterTree {
  title: string | null;
  taxon: string | null;
  tags: string[];
  route: string;
  metas: Map<string, string>;
  sourcePath: string;
  uri: string;
}

export type Forest = ForesterTree[];

// handles actually calling forester
export async function queryForest(): Promise<Forest> {
  const cwd = getRoot().fsPath;

  const config = vscode.workspace.getConfiguration("forester");
  const path = config.get("path") as string ?? "forester";
  const configfile = config.get("config") as string;

  const args = ["query", "all", ...(configfile ? [configfile] : [])]
  let forester = child_process.spawn(path, args, { cwd, detached: false, stdio: "pipe", windowsHide: true });

  let timeoutToken
  let stderr = ""
  let stdout = ""
  forester.stderr.on("data", (chunk) => { stderr += chunk });
  forester.stdout.on("data", (chunk) => { stdout += chunk });

  const [success, dataOrErrorMessage] = await new Promise<[boolean, { string: Omit<ForesterTree, 'uri'> } | Forest | string]>((resolve) => {
    timeoutToken = setTimeout(() => {
      resolve([false, 'Forester timed out after 30s'])
      forester.kill()
    }, 30000)

    forester.once('error', (error) => {
      vscode.window.showWarningMessage(`Forester: Critical error - ${error.message}`);
      resolve([false, error.message])
    })

    forester.once('close', (code, signal) => {
      if (signal !== null || code !== 0) {
        resolve([false, `Forester: process exited with code ${code} and signal ${signal}.`])
      } else {
        try {
          const result = JSON.parse(stdout)
          resolve([true, result])
        } catch (e) {
          resolve([false, "Forester didn't return a valid JSON response:\n" + stdout])
        }
      }
    })
  })

  clearTimeout(timeoutToken)

  if (success) {
    if (Array.isArray(dataOrErrorMessage)) {
      return dataOrErrorMessage as Forest // new query format
    } else {
      return Object.entries(dataOrErrorMessage).map(([id, entry]) => ({ uri: id, ...entry })) // old query format
    }
  } else {
    const errorMessage = dataOrErrorMessage + (stdout ? '\n\n' + stdout : '') + (stderr ? '\n\n' + stderr : '')

    console.log(errorMessage)
    vscode.window.showErrorMessage("Forester query failed: " + errorMessage);

    // if we can't get data, return empty array
    return [];
  }
}

export async function command(command: string[]) {
  // Get some configurations
  const config = vscode.workspace.getConfiguration("forester");
  const path: string = config.get("path") ?? "forester";
  const configfile: string | undefined = config.get("config");
  const root = getRoot();

  console.log(command);

  try {
    let { stdout, stderr } = await execFile(
      path,
      configfile ? [...command, configfile] : command,
      {
        cwd: root.fsPath,
        windowsHide: true,
      },
    );
    if (stderr) {
      vscode.window.showErrorMessage(stderr);
    }
    return stdout;
  } catch (e: any) {
    const errorMessage = e.toString() + (e.stdout ? '\n\n' + e.stdout : '') + (e.stderr ? '\n\n' + e.stderr : '')

    vscode.window.showErrorMessage(errorMessage);
  }
}
