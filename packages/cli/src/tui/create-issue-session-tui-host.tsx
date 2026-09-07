import { render } from 'ink';
import type {
  OperatorInputBinding,
  OperatorInputBindingApi,
  OperatorInputSubmitOptions,
  SessionLogSink,
} from '@agents-ensemble/core';
import type { SessionLogEvent } from '@agents-ensemble/core';
import type { SessionDisplayBackend } from '../display/session-display-backend.js';
import { formatConductorActivityBody } from '../session-log-lines.js';
import { IssueSessionTui } from './issue-session-tui.js';
import { IssueSessionTuiStream } from './issue-session-tui-stream.js';
import { createTuiViewModel } from './tui-view-model.js';
import { createTuiTelemetrySink } from './create-tui-telemetry-sink.js';
import { trimBlankLinesOnly } from './operator-input-layout.js';
import { supportsOsc8Hyperlinks } from './format-operator-context.js';
import { resolveTuiLayoutMode } from './tui-layout-mode.js';

const OPERATOR_MESSAGE_ENV = 'ENSEMBLE_OPERATOR_MESSAGE';

export interface IssueSessionTuiHost {
  displayBackend: SessionDisplayBackend;
  telemetrySink: SessionLogSink;
  bindOperatorInput: OperatorInputBinding;
  notifyReprompt: () => void;
  dispose: () => void;
}

function createInkDisplayBackend(
  viewModel: ReturnType<typeof createTuiViewModel>,
): SessionDisplayBackend {
  return {
    render(state, _previousState, event: SessionLogEvent) {
      viewModel.setDisplayState(state);

      if (event.type === 'operator.input') {
        viewModel.appendActivityLog('operator', event.text);
      }

      const conductorBody = formatConductorActivityBody(event);
      if (conductorBody) {
        viewModel.appendActivityLogSeparator();
        viewModel.appendActivityLog('conductor', conductorBody);
        viewModel.appendActivityLogSeparator();
      }
    },
  };
}

function createBindTuiOperatorInput(
  viewModel: ReturnType<typeof createTuiViewModel>,
  onSubmitRef: {
    current: ((text: string, options?: OperatorInputSubmitOptions) => void) | undefined;
  },
  apiRef: { current: OperatorInputBindingApi | undefined },
): OperatorInputBinding {
  return (api: OperatorInputBindingApi) => {
    const fromEnv = process.env[OPERATOR_MESSAGE_ENV]?.trim();
    if (fromEnv) {
      api.submit(fromEnv);
      return () => {};
    }

    if (!process.stdin.isTTY) {
      return () => {};
    }

    apiRef.current = api;
    onSubmitRef.current = (text: string, options?: OperatorInputSubmitOptions) => {
      const trimmed = trimBlankLinesOnly(text);
      if (trimmed) {
        api.submit(trimmed, options);
      }
    };

    viewModel.setOperatorContext(api.getContext());

    return () => {
      apiRef.current = undefined;
      if (onSubmitRef.current) {
        onSubmitRef.current = undefined;
      }
      viewModel.setOperatorContext(undefined);
    };
  };
}

/** TTY 向け Ink TUI を起動し、表示 backend とオペレータ入力 binding を返す。 */
export function createIssueSessionTuiHost(issueUrl?: string): IssueSessionTuiHost {
  const layoutMode = resolveTuiLayoutMode({ isTty: process.stdin.isTTY === true });
  const viewModel = createTuiViewModel({
    // Ink's Static requires an append-only item array. Pane mode keeps the
    // existing bounded in-memory window; stream mode retains the scrollback.
    activityLogWindowSize: layoutMode === 'stream' ? null : undefined,
  });
  const onSubmitRef: {
    current: ((text: string, options?: OperatorInputSubmitOptions) => void) | undefined;
  } = {
    current: undefined,
  };
  const apiRef: { current: OperatorInputBindingApi | undefined } = {
    current: undefined,
  };

  const commonProps = {
    viewModel,
    issueUrl,
    issueLinkMode: supportsOsc8Hyperlinks() ? ('osc8' as const) : ('label' as const),
    onSubmit: (text: string, options?: OperatorInputSubmitOptions) => {
      onSubmitRef.current?.(text, options);
    },
  };
  const ink = render(
    layoutMode === 'stream' ? (
      <IssueSessionTuiStream {...commonProps} />
    ) : (
      <IssueSessionTui {...commonProps} />
    ),
    { alternateScreen: false },
  );

  const inkDisplayBackend = createInkDisplayBackend(viewModel);
  const bindOperatorInput = createBindTuiOperatorInput(viewModel, onSubmitRef, apiRef);
  const telemetrySink = createTuiTelemetrySink(viewModel);

  return {
    displayBackend: {
      render(state, previousState, event) {
        inkDisplayBackend.render(state, previousState, event);
        if (apiRef.current) {
          viewModel.setOperatorContext(apiRef.current.getContext());
        }
      },
    },
    telemetrySink,
    bindOperatorInput,
    notifyReprompt: () => {
      if (apiRef.current) {
        viewModel.setOperatorContext(apiRef.current.getContext());
      }
    },
    dispose: () => {
      ink.unmount();
    },
  };
}
