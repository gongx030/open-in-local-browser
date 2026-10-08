import * as path from 'path';
import * as vscode from 'vscode';
import { StaticServer, TOKEN_PARAM, startStaticServer } from './staticServer';

export function activate(context: vscode.ExtensionContext): void {
  // One server per root, started on first use and kept until the window closes.
  const servers = new Map<string, Promise<StaticServer>>();

  const serverFor = (root: string): Promise<StaticServer> => {
    let server = servers.get(root);
    if (!server) {
      server = startStaticServer(root);
      servers.set(root, server);
      server.catch(() => servers.delete(root));
    }
    return server;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('openInLocalBrowser.open', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target || target.scheme !== 'file') {
        vscode.window.showErrorMessage('Open in Local Browser: select an HTML or PDF file on disk.');
        return;
      }
      // Serving from the workspace folder keeps links such as ../css/site.css working.
      const root =
        vscode.workspace.getWorkspaceFolder(target)?.uri.fsPath ?? path.dirname(target.fsPath);
      try {
        const server = await serverFor(root);
        const rel = path
          .relative(root, target.fsPath)
          .split(path.sep)
          .map(encodeURIComponent)
          .join('/');
        const local = vscode.Uri.parse(
          `http://127.0.0.1:${server.port}/${rel}?${TOKEN_PARAM}=${server.token}`,
        );
        // In a remote window this forwards the port to the local machine.
        const external = await vscode.env.asExternalUri(local);
        if (!(await vscode.env.openExternal(external))) {
          vscode.window.showErrorMessage(`Open in Local Browser: could not open ${external}`);
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Open in Local Browser: ${String(err)}`);
      }
    }),
    {
      dispose: () => {
        for (const server of servers.values()) {
          server.then((s) => s.close(), () => undefined);
        }
      },
    },
  );
}

export function deactivate(): void {}
