# Freshservice Task Scenario Extension

A standalone Chrome/Edge extension for managing Freshservice ticket tasks directly from the ticket detail page.

It helps service desk teams create repeatable task workflows, mark tasks as complete or open, assign agents, and bulk-update multiple ticket tasks without leaving Freshservice.

Note: the current extension UI includes Korean labels because it was originally built for an internal Korean service desk workflow. This README describes what each control does in English.

## Features

- Detects Freshservice ticket task rows on `/a/tickets/{ticketId}` pages.
- Adds inline controls for task selection, completion status, and agent assignment.
- Provides a sticky bulk action bar for multi-task updates.
- Supports drag selection across task rows for faster multi-task selection.
- Supports quick selection presets such as open tasks only and unassigned tasks only.
- Stores Freshservice settings locally in the browser.
- Calls the Freshservice API directly from the extension. No separate server is required.

## Installation

### Chrome

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select this folder.

### Edge

1. Open `edge://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select this folder.

```text
freshservice-scenario-extension
```

## Configuration

Click the extension icon to open the settings popup. The installed extension version is shown at the top of the popup.

1. Enter `FS_DOMAIN` and `FS_API_KEY`.
   - `FS_DOMAIN`: for example, `acme` or `acme.freshservice.com`
   - `FS_API_KEY`: your personal Freshservice API key
2. Click the save button.
3. After saving, the extension automatically runs a connection test.
4. Status messages are shown as loading, success, or error states.

Your API key is not sent to any third-party server. It is stored only in this browser's local extension storage. Freshservice task changes are recorded by Freshservice under the API key owner's account.

## Usage

1. Open a Freshservice ticket detail page, such as `/a/tickets/{ticketId}`.
2. Open the ticket's task tab or task section.
3. Use the inline status checkbox to switch a task between completed and open.
4. Use the inline agent dropdown to assign a task to an agent.
5. Result messages appear as toast notifications in the upper-right area of the page.

### Bulk Updates

When ticket tasks are visible, a bulk action bar appears above the task list.

1. Select target tasks using each row's selection checkbox or the bulk action bar.
   - Drag across task rows to select or deselect multiple tasks quickly.
   - Use the open-only preset to select only incomplete tasks.
   - Use the unassigned preset to select tasks without an assigned agent.
   - Selected rows are highlighted and marked with a selected label.
2. Run one of the bulk actions.
   - Mark selected tasks as completed.
   - Change selected tasks back to open.
   - Choose an agent, then apply that agent to the selected tasks.
   - Apply the selected agent only to currently unassigned tasks, regardless of the current selection.
   - Use the select-all and clear-selection controls to manage the current selection.
3. If more than five tasks are changed at once, a confirmation dialog is shown.
4. If some tasks fail, failed tasks remain selected so you can retry them.

Bulk updates are limited to 50 tasks per request.

## Security Notes

- The extension talks directly to the Freshservice API.
- No backend server is used.
- The API key is stored in local browser extension storage.
- On shared computers, remove the API key from the extension settings after use.

## Development

This extension uses Manifest V3 and plain JavaScript, HTML, and CSS.

Useful checks:

```bash
node --check content.js
node --check background.js
node --check settings.js
node -e "JSON.parse(require('fs').readFileSync('manifest.json', 'utf8')); console.log('manifest ok')"
```

## License

MIT
