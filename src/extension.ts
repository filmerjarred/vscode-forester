import * as vscode from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  Executable,
  TransportKind
} from 'vscode-languageclient/node';

import { Forest, cleanupServer, getForest, initForestMonitoring } from './get-forest';
import { getTemplate, getPrefix, getAvailableTemplates } from './utils';
import { command } from './server';

var client: LanguageClient;

function suggest(trees: Forest, range: vscode.Range) {
  var results : vscode.CompletionItem[] = [];
  const config = vscode.workspace.getConfiguration('forester');
  const showID = config.get('completion.showID') ?? false;
  for (const entry of trees) {
    let {uri: id, title, taxon} = entry;
    let item = new vscode.CompletionItem(
      { label: title === null ? `[${id}]` :
          showID ? `[${id}] ${title}` : title ,
        description: taxon ?? "" },
      vscode.CompletionItemKind.Value
    );
    item.range = range;
    item.insertText = id;
    item.filterText = `${id} ${title ?? ""} ${taxon ?? ""}`;
    item.detail = `${taxon ?? "Tree"} [${id}]`;
    item.documentation = title ?? undefined;
    results.push(item);
  }
  return results;
}

export function activate(context: vscode.ExtensionContext) {
  if (vscode.workspace.getConfiguration('forester').get("useLSP")) {

    let e : Executable = {
      command: "/Users/trebor/.opam/default/bin/forester",
      transport: TransportKind.stdio,
      args: ["lsp"],
    };

    let serverOptions: ServerOptions = {
      run: e, debug: e
    };
    let clientOptions: LanguageClientOptions = {
      documentSelector: [{ scheme: "file", language: "forester" }],
      synchronize: {
        fileEvents: vscode.workspace.createFileSystemWatcher("**/.tree"),
      },
    };

    client = new LanguageClient(
      'foresterLanguageClient',
      'Forester Language Client',
      serverOptions,
      clientOptions
    );

    client.start();

  } else {
    // We will complete ourselves

    // Initialize forest monitoring (handles file watching internally)
    initForestMonitoring(context);

    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(
        { scheme: 'file', language: 'forester' },
        {
          async provideCompletionItems(doc, pos) {
            // see if we should complete
            // \transclude{, \import{, \export{, \ref, [link](, [[link
            // There are three matching groups for the replacing content
            const tagPattern =
              /(?:\\transclude{|\\import{|\\export{|\\ref{)([^}]*)$|\[[^\[]*\]\(([^\)]*)$|\[\[([^\]]*)$/d;
            const text = doc.getText(
              new vscode.Range(new vscode.Position(pos.line, 0), pos)
            );
            let match = tagPattern.exec(text);
            if (match === null || match.indices === undefined) {
              return [];
            }

            // Get the needed range
            let ix =
              match.indices[1]?.[0] ??
              match.indices[2]?.[0] ??
              match.indices[3]?.[0] ??
              pos.character;
            let range = new vscode.Range(
              new vscode.Position(pos.line, ix),
              pos
            );

            const forest = await getForest({ fastReturnStale: true });

            return suggest(forest, range);
          },
          // resolveCompletionItem, we can extend the CompletionItem class to inject more information
        },
        '{', '(', '['
      )
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "forester.new",
      async function (folder?: vscode.Uri) {
        if (folder === undefined) {
          // Try to get from focused folder
          // https://github.com/Microsoft/vscode/issues/3553

          // "view/title": [
          //   {
          //     "command": "forester.new",
          //     "when": "view == workbench.explorer.fileView",
          //     "group": "navigation"
          //   }
          // ],
          return;
        }

        // Get prefix using utility function
        const prefix = await getPrefix();
        if (prefix === undefined) {
          return;  // Cancelled
        }

        // Get template using utility function
        const template = await getTemplate();

        const random : boolean = vscode.workspace
          .getConfiguration('forester')
          .get('create.random') ?? false;
        let result = (await command(["new",
          "--dest", folder.fsPath,
          "--prefix", prefix,
          ...(template ? [`--template=${template}`] : []),
          ...(random ? ["--random"] : [])
        ]))?.trim();
        if (result) {
          await vscode.window.showTextDocument(
            await vscode.workspace.openTextDocument(result)
          );
        }
      }
    ),
    vscode.commands.registerCommand(
      "forester.setDefaultPrefix",
      async () => {
        const config = vscode.workspace.getConfiguration("forester");
        const currentPrefix = config.get<string>("defaultPrefix") || "";

        const newPrefix = await vscode.window.showInputBox({
          prompt: "Enter the default prefix for new trees",
          placeHolder: "e.g., jms, ssl, djm",
          value: currentPrefix,
          validateInput: (value) => {
            if (!value) {
              return "Prefix cannot be empty";
            }
            if (!/^[a-zA-Z0-9-]+$/.test(value)) {
              return "Prefix should only contain letters, numbers, and hyphens";
            }
            return null;
          }
        });

        if (newPrefix) {
          await config.update("defaultPrefix", newPrefix, vscode.ConfigurationTarget.Workspace);
          vscode.window.showInformationMessage(`Default prefix set to: ${newPrefix}`);
        }
      }
    ),
    vscode.commands.registerCommand(
      "forester.setDefaultTemplate",
      async () => {
        const config = vscode.workspace.getConfiguration("forester");
        const templates = await getAvailableTemplates();

        const newTemplate = await vscode.window.showQuickPick(templates, {
          placeHolder: "Choose default template for new trees",
          canPickMany: false
        });

        if (newTemplate !== undefined) {
          await config.update("defaultTemplate", newTemplate, vscode.ConfigurationTarget.Workspace);
          vscode.window.showInformationMessage(`Default template set to: ${newTemplate}`);
        }
      }
    )
  );
}

// This method is called when your extension is deactivated
export function deactivate() {
  // Clean up server resources
  cleanupServer();

  if (client) {
    return client.stop();
  }
}
