import React from 'react';
import { render } from 'ink';
import { IssueSessionTui } from '../../dist/tui/issue-session-tui.js';
import { IssueSessionTuiStream } from '../../dist/tui/issue-session-tui-stream.js';
import { createTuiViewModel } from '../../dist/tui/tui-view-model.js';

const viewModel = createTuiViewModel();
const Tui = process.argv[2] === 'stream' ? IssueSessionTuiStream : IssueSessionTui;
const originalWrite = process.stdout.write.bind(process.stdout);
const frameMarker = Buffer.from('\u001b]777;ensemble-frame\u0007');
process.stdout.write = (chunk, encoding, callback) => {
  const callbackFn = typeof encoding === 'function' ? encoding : callback;
  const encodingName = typeof encoding === 'string' ? encoding : undefined;
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encodingName);
  return originalWrite(Buffer.concat([bytes, frameMarker]), callbackFn);
};

render(React.createElement(Tui, {
  viewModel,
  onSubmit: () => {},
}), { exitOnCtrlC: false, interactive: true });

setTimeout(() => {
  viewModel.setConductorStatus({
    text: 'clock-fixture',
    since: Date.now(),
  });
}, 1_000);
