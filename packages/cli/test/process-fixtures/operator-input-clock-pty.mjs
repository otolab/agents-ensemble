import React from 'react';
import { render } from 'ink';

const mode = process.argv[2];
const scenario = process.argv[3] ?? '';
let viewModel;
const originalWrite = process.stdout.write.bind(process.stdout);
const frameMarker = Buffer.from('\u001b]777;ensemble-frame\u0007');
process.stdout.write = (chunk, encoding, callback) => {
  const callbackFn = typeof encoding === 'function' ? encoding : callback;
  const encodingName = typeof encoding === 'string' ? encoding : undefined;
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encodingName);
  return originalWrite(Buffer.concat([bytes, frameMarker]), callbackFn);
};

if (mode === 'operator-agent') {
  const { createOperatorAgentTuiHost } = await import(
    '../../../operator-agent/dist/tui/operator-agent-tui.js'
  );
  const tui = createOperatorAgentTuiHost({
    stdin: process.stdin,
    stdout: process.stdout,
    colorEnabled: false,
    onSubmit: () => {},
    onInterrupt: () => {},
  });
  tui.setHarnessStatus('監視報告: 解除（理由: なし、保留件数: 0 件）');
  tui.setStatus('clock-fixture', Date.now());
} else {
  const { IssueSessionTui } = await import('../../dist/tui/issue-session-tui.js');
  const { IssueSessionTuiStream } = await import('../../dist/tui/issue-session-tui-stream.js');
  const { createTuiViewModel } = await import('../../dist/tui/tui-view-model.js');
  viewModel = createTuiViewModel();
  const Tui = mode === 'stream' ? IssueSessionTuiStream : IssueSessionTui;
  if (scenario.includes('question')) {
    viewModel.setOperatorContext({
      conductorTurn: 1,
      autonomousTurns: 0,
      maxTurns: 5,
      openQuestions: [{
        id: 'inq-pty',
        question: 'Which approach should we take for this operator input cursor regression?',
        context: 'Compare the current pane layout with the stream layout after resizing.',
        responseType: 'text',
        source: 'conductor',
        status: 'open',
        askedAt: Date.now(),
      }],
    });
  }
  if (scenario.includes('workers')) {
    viewModel.setDisplayState({
      ...viewModel.getSnapshot().displayState,
      workers: {
        implementer: { kind: 'implementer', status: 'running', activity: 'editing' },
        reviewer: { kind: 'reviewer', status: 'idle' },
      },
    });
  }
  render(React.createElement(Tui, {
    viewModel,
    onSubmit: () => {},
  }), { exitOnCtrlC: false, interactive: true });
}

setTimeout(() => {
  if (viewModel) {
    viewModel.setConductorStatus({
      text: 'clock-fixture',
      since: Date.now(),
    });
  }
}, 1_000);
