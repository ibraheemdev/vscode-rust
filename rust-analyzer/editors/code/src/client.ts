import * as lc from 'vscode-languageclient';
import * as vscode from 'vscode';
import * as ra from '../src/lsp_ext';
import * as Is from 'vscode-languageclient/lib/utils/is';

import { CallHierarchyFeature } from 'vscode-languageclient/lib/callHierarchy.proposed';
import { SemanticTokensFeature, DocumentSemanticsTokensSignature } from 'vscode-languageclient/lib/semanticTokens.proposed';
import { assert } from './util';

function toTrusted(obj: vscode.MarkedString): vscode.MarkedString {
    const md = <vscode.MarkdownString>obj;
    if (md && md.value.includes("```rust")) {
        md.isTrusted = true;
        return md;
    }
    return obj;
}

function renderCommand(cmd: CommandLink) {
    return `[${cmd.title}](command:${cmd.command}?${encodeURIComponent(JSON.stringify(cmd.arguments))} '${cmd.tooltip!}')`;
}

function renderHoverActions(actions: CommandLinkGroup[]): vscode.MarkdownString {
    const text = actions.map(group =>
        (group.title ? (group.title + " ") : "") + group.commands.map(renderCommand).join(' | ')
    ).join('___');

    const result = new vscode.MarkdownString(text);
    result.isTrusted = true;
    return result;
}

export function createClient(serverPath: string, cwd: string): lc.LanguageClient {
    // '.' Is the fallback if no folder is open
    // TODO?: Workspace folders support Uri's (eg: file://test.txt).
    // It might be a good idea to test if the uri points to a file.

    const run: lc.Executable = {
        command: serverPath,
        options: { cwd },
    };
    const serverOptions: lc.ServerOptions = {
        run,
        debug: run,
    };
    const traceOutputChannel = vscode.window.createOutputChannel(
        'Rust Analyzer Language Server Trace',
    );

    const clientOptions: lc.LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'rust' }],
        initializationOptions: vscode.workspace.getConfiguration("rust-analyzer"),
        traceOutputChannel,
        middleware: {
            // Workaround for https://github.com/microsoft/vscode-languageserver-node/issues/576
            async provideDocumentSemanticTokens(document: vscode.TextDocument, token: vscode.CancellationToken, next: DocumentSemanticsTokensSignature) {
                const res = await next(document, token);
                if (res === undefined) throw new Error('busy');
                return res;
            },
            async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, _next: lc.ProvideHoverSignature) {
                return client.sendRequest(lc.HoverRequest.type, client.code2ProtocolConverter.asTextDocumentPositionParams(document, position), token).then(
                    (result) => {
                        const hover = client.protocol2CodeConverter.asHover(result);
                        if (hover) {
                            // Workaround to support command links (trusted vscode.MarkdownString) in hovers
                            // https://github.com/microsoft/vscode/issues/33577
                            hover.contents = hover.contents.map(toTrusted);
                            
                            const actions = (<any>result).actions;
                            if (actions) {
                                hover.contents.push(renderHoverActions(actions));
                            }
                        }
                        return hover;
                    },
                    (error) => {
                        client.logFailedRequest(lc.HoverRequest.type, error);
                        return Promise.resolve(null);
                    });
            },
            // Using custom handling of CodeActions where each code action is resloved lazily
            // That's why we are not waiting for any command or edits
            async provideCodeActions(document: vscode.TextDocument, range: vscode.Range, context: vscode.CodeActionContext, token: vscode.CancellationToken, _next: lc.ProvideCodeActionsSignature) {
                const params: lc.CodeActionParams = {
                    textDocument: client.code2ProtocolConverter.asTextDocumentIdentifier(document),
                    range: client.code2ProtocolConverter.asRange(range),
                    context: client.code2ProtocolConverter.asCodeActionContext(context)
                };
                return client.sendRequest(lc.CodeActionRequest.type, params, token).then((values) => {
                    if (values === null) return undefined;
                    const result: (vscode.CodeAction | vscode.Command)[] = [];
                    const groups = new Map<string, { index: number; items: vscode.CodeAction[] }>();
                    for (const item of values) {
                        // In our case we expect to get code edits only from diagnostics
                        if (lc.CodeAction.is(item)) {
                            assert(!item.command, "We don't expect to receive commands in CodeActions");
                            const action = client.protocol2CodeConverter.asCodeAction(item);
                            result.push(action);
                            continue;
                        }
                        assert(isCodeActionWithoutEditsAndCommands(item), "We don't expect edits or commands here");
                        const action = new vscode.CodeAction(item.title);
                        const group = (item as any).group;
                        const id = (item as any).id;
                        const resolveParams: ra.ResolveCodeActionParams = {
                            id: id,
                            codeActionParams: params
                        };
                        action.command = {
                            command: "rust-analyzer.resolveCodeAction",
                            title: item.title,
                            arguments: [resolveParams],
                        };
                        if (group) {
                            let entry = groups.get(group);
                            if (!entry) {
                                entry = { index: result.length, items: [] };
                                groups.set(group, entry);
                                result.push(action);
                            }
                            entry.items.push(action);
                        } else {
                            result.push(action);
                        }
                    }
                    for (const [group, { index, items }] of groups) {
                        if (items.length === 1) {
                            result[index] = items[0];
                        } else {
                            const action = new vscode.CodeAction(group);
                            action.command = {
                                command: "rust-analyzer.applyActionGroup",
                                title: "",
                                arguments: [items.map((item) => {
                                    return { label: item.title, arguments: item.command!!.arguments!![0] };
                                })],
                            };
                            result[index] = action;
                        }
                    }
                    return result;
                },
                    (_error) => undefined
                );
            }

        } as any
    };

    const client = new lc.LanguageClient(
        'rust-analyzer',
        'Rust Analyzer Language Server',
        serverOptions,
        clientOptions,
    );

    // To turn on all proposed features use: client.registerProposedFeatures();
    // Here we want to enable CallHierarchyFeature and SemanticTokensFeature
    // since they are available on stable.
    // Note that while these features are stable in vscode their LSP protocol
    // implementations are still in the "proposed" category for 3.16.
    client.registerFeature(new CallHierarchyFeature(client));
    client.registerFeature(new SemanticTokensFeature(client));
    client.registerFeature(new ExperimentalFeatures());

    return client;
}

class ExperimentalFeatures implements lc.StaticFeature {
    fillClientCapabilities(capabilities: lc.ClientCapabilities): void {
        const caps: any = capabilities.experimental ?? {};
        caps.snippetTextEdit = true;
        caps.codeActionGroup = true;
        caps.resolveCodeAction = true;
        caps.hoverActions = true;
        capabilities.experimental = caps;
    }
    initialize(_capabilities: lc.ServerCapabilities<any>, _documentSelector: lc.DocumentSelector | undefined): void {
    }
}

function isCodeActionWithoutEditsAndCommands(value: any): boolean {
    const candidate: lc.CodeAction = value;
    return candidate && Is.string(candidate.title) &&
        (candidate.diagnostics === void 0 || Is.typedArray(candidate.diagnostics, lc.Diagnostic.is)) &&
        (candidate.kind === void 0 || Is.string(candidate.kind)) &&
        (candidate.edit === void 0 && candidate.command === void 0);
}
