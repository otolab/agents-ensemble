import { render } from 'ink';
import type {
  OperatorInputBinding,
  OperatorInputBindingApi,
  SessionLogSink,
} from '@agents-ensemble/core';
import type { SessionLogEvent } from '@agents-ensemble/core';
import type { SessionDisplayBackend } from '../display/session-display-backend.js';
import { formatConductorActivityBody } from '../session-log-lines.js';
import { IssueSessionTui } from './issue-session-tui.js';
import { createTuiViewModel } from './tui-view-model.js';
import { createTuiTelemetrySink } from './create-tui-telemetry-sink.js';

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
        viewModel.appendActivityLog('conductor', conductorBody);
      }
    },
  };
}

function createBindTuiOperatorInput(
  viewModel: ReturnType<typeof createTuiViewModel>,
  onSubmitRef: { current: ((text: string) => void) | undefined },
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
    onSubmitRef.current = (text: string) => {
      const trimmed = text.trim();
      if (trimmed) {
        api.submit(trimmed);
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
export function createIssueSessionTuiHost(): IssueSessionTuiHost {
  const viewModel = createTuiViewModel();
  const onSubmitRef: { current: ((text: string) => void) | undefined } = {
    current: undefined,
  };
  const apiRef: { current: OperatorInputBindingApi | undefined } = {
    current: undefined,
  };

  const ink = render(
    <IssueSessionTui
      viewModel={viewModel}
      onSubmit={(text) => {
        onSubmitRef.current?.(text);
      }}
    />,
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
