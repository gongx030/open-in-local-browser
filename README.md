# open-in-local-browser

In a VS Code Remote-SSH window, right-click an HTML or PDF file and choose
**Open in Local Browser**. The file opens in the default browser on your own
machine (for example, the Mac you are connecting from), not in a VS Code panel.
PDFs are shown by the browser's built-in PDF viewer.

The command is in the Explorer context menu, the editor context menu, the
editor tab context menu, and the Command Palette, for files ending in `.html`,
`.htm` or `.pdf` (case-insensitive).

## Install

```bash
npm install
npx @vscode/vsce package               # -> open-in-local-browser-0.1.0.vsix
code --install-extension open-in-local-browser-0.1.0.vsix
```

In a Remote-SSH window, run `code --install-extension` from a terminal on the
remote host, then reload the window. The extension runs on the remote host
(`extensionKind: ["workspace"]`).

## How it works

1. On first use for a workspace folder, it starts a static HTTP server on the
   remote host, bound to `127.0.0.1` on an OS-assigned port. It serves the
   workspace folder that contains the file (or the file's own folder if it is
   outside every workspace folder), so relative links to CSS, scripts and
   images resolve.
2. `vscode.env.asExternalUri` forwards that port to your local machine, the
   same port forwarding listed in the **Ports** panel.
3. `vscode.env.openExternal` opens the forwarded URL in the local default
   browser.

Files are read from disk on every request (`Cache-Control: no-store`), so
saving the file and refreshing the browser shows the change. There is no
automatic reload.

Large HTML files (5 MB or more, typically self-contained pages with inlined
images) can take minutes to arrive over the forwarded port, and the browser
would show a blank tab meanwhile. For these the server first returns a small
loading page that downloads the file with a progress bar and then replaces
itself with it, keeping the same URL so relative links still resolve.

## Access control

Other users on a shared host can connect to a `127.0.0.1` port. Each server
therefore generates a random token. The first request must carry it as
`?token=…`; the server answers with an `HttpOnly` cookie, which authorizes the
page's later asset requests. Requests without the token get 403, and paths
outside the served folder get 404.

## Limitations

- Unsaved editor changes are not shown; the server serves the file on disk.
- Servers stop when the VS Code window closes or reloads. A browser tab left
  open from an earlier window then gets errors, so re-run the command.
