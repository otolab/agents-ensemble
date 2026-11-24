import React from 'react';
import { render } from 'ink';
import { IssueSessionTui } from '../../dist/tui/issue-session-tui.js';
import { IssueSessionTuiStream } from '../../dist/tui/issue-session-tui-stream.js';
import { createTuiViewModel } from '../../dist/tui/tui-view-model.js';

// A PTY represents an interactive terminal even when the test runner is in CI.
const Tui = process.argv[2] === 'stream' ? IssueSessionTuiStream : IssueSessionTui;
render(React.createElement(Tui, {
  viewModel: createTuiViewModel(),
  onSubmit: () => {},
}), { exitOnCtrlC: false, interactive: true });
