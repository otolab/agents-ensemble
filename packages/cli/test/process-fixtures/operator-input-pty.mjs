import React from 'react';
import { render } from 'ink';
import { IssueSessionTui } from '../../dist/tui/issue-session-tui.js';
import { createTuiViewModel } from '../../dist/tui/tui-view-model.js';

// A PTY represents an interactive terminal even when the test runner is in CI.
render(React.createElement(IssueSessionTui, {
  viewModel: createTuiViewModel(),
  onSubmit: () => {},
}), { exitOnCtrlC: false, interactive: true });
