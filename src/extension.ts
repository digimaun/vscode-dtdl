// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";
import { ColorizedChannel } from "./common/colorizedChannel";
import { Constants } from "./common/constants";
import { EventType } from "./common/eventType";
import { ProcessError } from "./common/processError";
import { TelemetryClient } from "./common/telemetryClient";
import { TelemetryContext } from "./common/telemetryContext";
import { UserCancelledError } from "./common/userCancelledError";
import { DeviceModelManager, ModelType } from "./deviceModel/deviceModelManager";
import { MessageType, UI } from "./view/ui";
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from "vscode-languageclient";

let client: LanguageClient;

function initCommand(
  context: vscode.ExtensionContext,
  telemetryClient: TelemetryClient,
  outputChannel: ColorizedChannel,
  event: EventType,
  // eslint-disable-next-line  @typescript-eslint/no-explicit-any
  callback: (...args: any[]) => Promise<any>
): void {
  context.subscriptions.push(
    // eslint-disable-next-line  @typescript-eslint/no-explicit-any
    vscode.commands.registerCommand(event, async (...args: any[]) => {
      const telemetryContext: TelemetryContext = TelemetryContext.startNew();
      try {
        return await callback(...args);
      } catch (err) {
        const error = err as any;
        telemetryContext.setError(error);
        if (error instanceof UserCancelledError) {
          outputChannel.warn(error.message);
        } else {
          UI.showNotification(MessageType.Error, error.message);
          if (error instanceof ProcessError) {
            const message = `${error.message}\n${error.stack}`;
            outputChannel.error(message, error.component);
          } else {
            outputChannel.error(error.message);
          }
        }
      } finally {
        telemetryContext.end();
        telemetryClient.sendEvent(event, telemetryContext);
        outputChannel.show();
      }
    })
  );
}

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = new ColorizedChannel(Constants.CHANNEL_NAME);
  const telemetryClient = new TelemetryClient(context);
  const deviceModelManager = new DeviceModelManager(context, outputChannel);

  telemetryClient.sendEvent(Constants.EXTENSION_ACTIVATED_MSG);
  context.subscriptions.push(outputChannel);
  context.subscriptions.push(telemetryClient);

  // Use local absolute path for debugging
  const serverPath = context.asAbsolutePath(Constants.DTDL_LANGUAGE_SERVER_RELATIVE_PATH);
  const debugOptions = { execArgv: ["--nolazy", "--inspect=6009"] };

  const serverOptions: ServerOptions = {
    run: { module: serverPath, transport: TransportKind.ipc },
    debug: {
      module: serverPath,
      transport: TransportKind.ipc,
      options: debugOptions
    }
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "json" }],
    middleware: {
      executeCommand: async (command, args, next) => {
        if (command === "vscode-dtdl.importModel") {
          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (workspaceFolders === undefined) {
            return;
          }
          const workspaceTable: { [name: string]: vscode.Uri } = {};
          workspaceFolders.forEach(workspace => {
            workspaceTable[workspace.name] = workspace.uri;
          });
          const targetWorkspace = await vscode.window.showQuickPick(Object.keys(workspaceTable), {
            placeHolder: "Target workspace for import"
          });

          if (targetWorkspace === undefined) {
            return;
          }

          const selected = await vscode.window.showQuickPick(["From IoT Models Repository", "From File"]);
          if (selected === "From IoT Models Repository") {
            const targetType = "dmr";
            const dtmiInput = await vscode.window.showInputBox({
              prompt: "Input dtmi",
              placeHolder: "dtmi:com:example:TemperatureController;1"
            });
            if (!dtmiInput) {
              return;
            }
            args.push(workspaceTable[targetWorkspace].toString());
            args.push(targetType);
            args.push(dtmiInput);
            return next(command, args);
          } else if (selected === "From File") {
            const targetType = "file";
            const pathInput = await vscode.window.showInputBox({
              prompt: "Path to expanded model file",
              placeHolder: "/path/to/expanded/model.json"
            });
            if (!pathInput) {
              return;
            }
            args.push(workspaceTable[targetWorkspace].toString());
            args.push(targetType);
            args.push(pathInput);
            return next(command, args);
          }
        }

        return;
      }
    }
  };

  client = new LanguageClient(
    Constants.DTDL_LANGUAGE_SERVER_ID,
    Constants.DTDL_LANGUAGE_SERVER_NAME,
    serverOptions,
    clientOptions
  );

  client.onReady().then(() => {
    client.onNotification("custom/onDidOpenModelFile", version => {
      const telemetryContext: TelemetryContext = TelemetryContext.startNew();
      telemetryContext.properties.dtdlVersion = version;
      telemetryContext.end();
      telemetryClient.sendEvent(EventType.OpenModelFile, telemetryContext);
    });
  });

  client.start();

  initCommand(
    context,
    telemetryClient,
    outputChannel,
    EventType.CreateInterface,
    async (): Promise<void> => {
      return deviceModelManager.createModel(ModelType.Interface);
    }
  );
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
