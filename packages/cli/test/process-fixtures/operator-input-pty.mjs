import React from 'react';
import { render } from 'ink';
import { IssueSessionTui } from '../../dist/tui/issue-session-tui.js';
import { createTuiViewModel } from '../../dist/tui/tui-view-model.js';

render(React.createElement(IssueSessionTui, {
  viewModel: createTuiViewModel(),
  onSubmit: () => {},
}), { exitOnCtrlC: false });
