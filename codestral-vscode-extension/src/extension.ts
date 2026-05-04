import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import * as childProcess from 'child_process';
import * as path from 'path';

interface CodestralCompletionResponse {
    choices: Array<{
        text: string;
        index: number;
        finish_reason: string;
    }>;
    usage?: TokenUsage;
}

interface CodestralChatResponse {
    choices: Array<{
        message: {
            role: string;
            content: string;
        };
        index: number;
        finish_reason: string;
    }>;
    usage?: TokenUsage;
}

interface TokenUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    promptTokens?: number;
    completionTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
}

interface IntentRoute {
    route: 'chat' | 'agent' | 'explain' | 'review';
    reason: string;
}

interface MistralModelsResponse {
    data?: Array<{
        id: string;
        object?: string;
        created?: number;
        owned_by?: string;
    }>;
}

interface ActiveCodeInput {
    editor: vscode.TextEditor;
    document: vscode.TextDocument;
    range: vscode.Range;
    text: string;
    isSelection: boolean;
}

interface AgentChange {
    path: string;
    action: 'create' | 'modify' | 'delete';
    content?: string;
    unifiedDiff?: string;
    baseContentHash?: string;
}

interface AgentPatch {
    summary: string;
    plan: string[];
    changes: AgentChange[];
    testCommand?: string;
    notes?: string[];
}

interface CommandResult {
    output: string;
    exitCode: number | null;
}

interface ValidationCommand {
    label: string;
    command: string;
    kind?: 'shell' | 'static-smoke';
    files?: string[];
}

interface DiffHunk {
    oldStart: number;
    lines: string[];
}

interface ProjectEnvironmentProfile {
    type: string;
    packageManager?: string;
    scripts: string[];
    validation: string[];
    devServer?: string;
    notes: string[];
}

interface AgentBackup {
    path: string;
    existed: boolean;
    content: string;
}

interface AgentRunState {
    summary: string;
    backups: AgentBackup[];
}

interface AgentRunRecord extends AgentRunState {
    id: string;
    task: string;
    createdAt: number;
    changes: Array<{
        path: string;
        action: AgentChange['action'];
    }>;
    testCommand?: string;
    testExitCode?: number | null;
    testOutputPreview?: string;
}

interface AgentAutonomyState {
    id: string;
    task: string;
    status: 'running' | 'success' | 'blocked' | 'stopped';
    iteration: number;
    maxIterations: number;
    phase: string;
    updatedAt: number;
    lastError?: string;
    lastTestCommand?: string;
    lastTestExitCode?: number | null;
}

interface ProjectMemory {
    version: number;
    updatedAt: number;
    workspace: string;
    projectType: string;
    recentAgentRuns: Array<{
        id: string;
        task: string;
        summary: string;
        createdAt: number;
        changes: Array<{
            path: string;
            action: AgentChange['action'];
        }>;
        testCommand?: string;
        testExitCode?: number | null;
    }>;
    lastAgentState?: AgentAutonomyState;
    directories: Array<{
        path: string;
        files: number;
        languages: string[];
    }>;
    environment?: ProjectEnvironmentProfile;
    workspaceIndex: WorkspaceIndexEntry[];
}

interface ChatHistoryItem {
    role: 'Vous' | 'Codestral' | 'Erreur' | 'Agent';
    text: string;
    kind: 'user' | 'assistant' | 'error';
}

interface ChatSession {
    id: string;
    title: string;
    items: ChatHistoryItem[];
    updatedAt: number;
}

interface UiText {
    htmlLang: string;
    ready: string;
    thinking: string;
    empty: string;
    placeholder: string;
    hint: string;
    key: string;
    models: string;
    stop: string;
    rerun: string;
    settingsTitle: string;
    model: string;
    history: string;
    historyTitle: string;
    newChat: string;
    agent: string;
    send: string;
    activeModel: string;
    tokens: string;
}

interface WorkspaceIndexEntry {
    path: string;
    language: string;
    size: number;
    summary: string;
    updatedAt: number;
}

let activeCommandProcess: childProcess.ChildProcess | undefined;
let activeDevServerProcess: childProcess.ChildProcess | undefined;
let lastDevServerCommand: { command: string; cwd: string } | undefined;
let lastShellCommand: { command: string; cwd: string } | undefined;
let extensionContextRef: vscode.ExtensionContext | undefined;
let workspaceIndexCache: WorkspaceIndexEntry[] = [];
let lastTokenUsage: TokenUsage | undefined;
let lastActiveTextEditor: vscode.TextEditor | undefined;
let lastSidebarAssistantText = '';

class AgentDiffContentProvider implements vscode.TextDocumentContentProvider {
    private readonly contents = new Map<string, string>();
    private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this.emitter.event;

    set(uri: vscode.Uri, content: string): void {
        this.contents.set(uri.toString(), content);
        this.emitter.fire(uri);
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this.contents.get(uri.toString()) ?? '';
    }
}

class CodestralSidebarProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'codestral-ai.sidebar';

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly getApiKey: () => string,
        private readonly getConfig: () => vscode.WorkspaceConfiguration,
        private readonly getHistory: () => ChatHistoryItem[],
        private readonly saveHistory: (history: ChatHistoryItem[]) => Thenable<void>,
        private readonly getSessions: () => ChatSession[],
        private readonly saveSessions: (sessions: ChatSession[]) => Thenable<void>,
        private readonly getCurrentSessionId: () => string,
        private readonly setCurrentSessionId: (sessionId: string) => Thenable<void>
    ) {}

    private webviewView?: vscode.WebviewView;

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this.webviewView = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.extensionUri, 'icons')
            ]
        };

        webviewView.webview.html = this.getHtml(webviewView.webview);
        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (!message || typeof message.command !== 'string') {
                return;
            }

            if (message.command === 'codestral-ai.sidebarChat') {
                await this.handleSidebarChat(webviewView.webview, String(message.text || ''));
                return;
            }

            if (message.command === 'codestral-ai.sidebarAgent') {
                await this.handleSidebarAgent(webviewView.webview, String(message.text || ''));
                return;
            }

            if (message.command === 'codestral-ai.newChat') {
                await this.startNewChat(webviewView.webview);
                return;
            }

            if (message.command === 'codestral-ai.showChatHistory') {
                await this.showChatHistory(webviewView.webview);
                return;
            }

            await vscode.commands.executeCommand(message.command);

            if (message.command === 'codestral-ai.selectModel' || message.command === 'codestral-ai.showAvailableModels') {
                webviewView.webview.postMessage({
                    type: 'model',
                    model: this.getConfig().get<string>('model', 'codestral-latest')
                });
            }

            if (message.command === 'codestral-ai.openSettingsMenu') {
                webviewView.webview.html = this.getHtml(webviewView.webview);
            }
        });
    }

    private async handleSidebarAgent(webview: vscode.Webview, text: string): Promise<void> {
        const task = text.trim();
        if (!task) {
            webview.postMessage({
                type: 'error',
                text: 'Décris une tâche avant de lancer le mode agent.'
            });
            return;
        }

        await this.appendHistory({
            role: 'Vous',
            text: task,
            kind: 'user'
        });
        webview.postMessage({
            type: 'answer',
            text: 'Je lance le mode agent.'
        });
        await vscode.commands.executeCommand('codestral-ai.agentTask', task);
    }

    async postAgentUpdate(text: string): Promise<void> {
        const item: ChatHistoryItem = {
            role: 'Agent',
            text,
            kind: 'assistant'
        };
        const history = [...this.getHistory(), item].slice(-60);
        await this.saveHistory(history);
        this.webviewView?.webview.postMessage({
            type: 'historyItem',
            item
        });
    }

    postAgentPlan(title: string, steps: Array<{ label: string; status: string }>): void {
        this.webviewView?.webview.postMessage({
            type: 'agentPlan',
            title,
            steps
        });
    }

    postAgentTimeline(title: string, events: Array<{ phase: string; status: string; detail?: string }>): void {
        this.webviewView?.webview.postMessage({
            type: 'agentTimeline',
            title,
            events
        });
    }

    postTokenUsage(usage?: TokenUsage): void {
        this.webviewView?.webview.postMessage({
            type: 'tokenUsage',
            usage
        });
    }

    private async handleSidebarChat(webview: vscode.Webview, text: string) {
        const question = text.trim();
        if (!question) {
            return;
        }

        const apiKey = this.getApiKey();
        if (!apiKey) {
            webview.postMessage({
                type: 'error',
                text: 'Clé API Codestral non configurée.'
            });
            await vscode.commands.executeCommand('codestral-ai.setApiKey');
            return;
        }

        const config = this.getConfig();
        const maxTokens = config.get<number>('agentMaxTokens', 4000);
        const temperature = config.get<number>('temperature', 0.3);
        const model = config.get<string>('model', 'codestral-latest');
        const responseLanguage = config.get<string>('responseLanguage', 'français');
        const editorContext = getActiveEditorContext();
        const previousHistory = this.getHistory();
        const followUpAgentTask = buildFollowUpAgentTask(question, previousHistory, lastSidebarAssistantText);

        if (followUpAgentTask || shouldStartAgentLocally(question, previousHistory)) {
            await this.appendHistory({
                role: 'Vous',
                text: question,
                kind: 'user'
            });
            webview.postMessage({
                type: 'answer',
                text: followUpAgentTask
                    ? 'Je lance le mode agent avec la proposition précédente.'
                    : 'Je lance le mode agent pour modifier le workspace.'
            });
            await vscode.commands.executeCommand('codestral-ai.agentTask', followUpAgentTask ?? question);
            return;
        }

        const workspaceContext = await collectWorkspaceContext(question);
        const prompt = [
            'Tu es Codestral Agent, un agent de code intégré à VSCodium.',
            'L’utilisateur écrit naturellement, comme avec Codex.',
            `Réponds en ${responseLanguage}.`,
            'Si la demande demande de coder, réponds avec un plan court, les fichiers à modifier et le code proposé.',
            'Si tu as besoin de modifier plusieurs fichiers, donne chaque fichier avec son chemin et son contenu proposé.',
            'Ne prétends pas avoir appliqué des changements si tu ne les as pas appliqués.',
            '',
            editorContext ? `Contexte éditeur actif:\n${editorContext}` : '',
            '',
            workspaceContext,
            '',
            `Demande utilisateur:\n${question}`
        ].filter(Boolean).join('\n');

        webview.postMessage({ type: 'pending' });
        await this.appendHistory({
            role: 'Vous',
            text: question,
            kind: 'user'
        });

        try {
            const route = await routeSidebarIntent(apiKey, question, editorContext, model);
            if (lastTokenUsage) {
                webview.postMessage({
                    type: 'tokenUsage',
                    usage: lastTokenUsage
                });
            }
            if (route.route === 'agent' || (route.route === 'chat' && isWorkspaceWriteRequest(question))) {
                webview.postMessage({
                    type: 'answer',
                    text: `Je lance le mode agent: ${route.reason || 'la demande implique des changements dans le workspace.'}`
                });
                await vscode.commands.executeCommand('codestral-ai.agentTask', question);
                return;
            }

            const response = await callCodestralChat(apiKey, prompt, maxTokens, temperature, model);
            lastSidebarAssistantText = response || '';
            await extensionContextRef?.globalState.update('lastSidebarAssistantText', lastSidebarAssistantText);
            if (lastTokenUsage) {
                webview.postMessage({
                    type: 'tokenUsage',
                    usage: lastTokenUsage
                });
            }
            await this.appendHistory({
                role: 'Codestral',
                text: response || 'Aucune réponse reçue.',
                kind: 'assistant'
            });
            webview.postMessage({
                type: 'answer',
                text: response || 'Aucune réponse reçue.'
            });
        } catch (error) {
            const errorText = error instanceof Error ? error.message : String(error);
            await this.appendHistory({
                role: 'Erreur',
                text: errorText,
                kind: 'error'
            });
            webview.postMessage({
                type: 'error',
                text: errorText
            });
        }
    }

    private async appendHistory(item: ChatHistoryItem): Promise<void> {
        const history = [...this.getHistory(), item].slice(-60);
        await this.saveHistory(history);
    }

    private async startNewChat(webview: vscode.Webview): Promise<void> {
        const session = createChatSession([]);
        const sessions = [session, ...this.getSessions()].slice(0, 50);
        await this.saveSessions(sessions);
        await this.setCurrentSessionId(session.id);
        webview.postMessage({
            type: 'history',
            items: []
        });
    }

    private async showChatHistory(webview: vscode.Webview): Promise<void> {
        const sessions = this.getSessions()
            .filter(session => session.items.length > 0 || session.id === this.getCurrentSessionId())
            .sort((a, b) => b.updatedAt - a.updatedAt);

        if (sessions.length === 0) {
            vscode.window.showInformationMessage('Aucun historique Codestral pour le moment.');
            return;
        }

        const selected = await vscode.window.showQuickPick(
            sessions.map(session => ({
                label: session.title || 'Nouvelle conversation',
                description: new Date(session.updatedAt).toLocaleString(),
                detail: `${session.items.length} message(s)`,
                session
            })),
            {
                title: 'Codestral: Historique des chats',
                placeHolder: 'Choisis une conversation à rouvrir'
            }
        );

        if (!selected) {
            return;
        }

        await this.setCurrentSessionId(selected.session.id);
        webview.postMessage({
            type: 'history',
            items: selected.session.items
        });
    }

    private getHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        const logoUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'icons', 'codestral-icon.svg')
        );
        const initialHistory = JSON.stringify(this.getHistory()).replace(/</g, '\\u003c');
        const initialModel = JSON.stringify(this.getConfig().get<string>('model', 'codestral-latest')).replace(/</g, '\\u003c');
        const initialTokenUsage = JSON.stringify(lastTokenUsage ?? null).replace(/</g, '\\u003c');
        const uiText = getUiText(this.getConfig().get<string>('interfaceLanguage', 'français'));
        const initialUiText = JSON.stringify(uiText).replace(/</g, '\\u003c');

        return `<!DOCTYPE html>
<html lang="${uiText.htmlLang}">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        html,
        body {
            height: 100%;
            margin: 0;
        }

        body {
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
        }

        .shell {
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
            height: 100vh;
            padding: 12px;
            gap: 10px;
        }

        header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            flex: 0 0 auto;
        }

        h2 {
            margin: 0;
            font-size: 14px;
            font-weight: 600;
        }

        .brand {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
        }

        .brand img {
            width: 24px;
            height: 24px;
            flex: 0 0 auto;
            border-radius: 5px;
        }

        .status {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            white-space: nowrap;
        }

        .status::before {
            content: "";
            width: 7px;
            height: 7px;
            border-radius: 50%;
            background: #22c55e;
        }

        .header-meta {
            display: grid;
            gap: 2px;
            justify-items: end;
            min-width: 0;
        }

        .usage {
            color: var(--vscode-descriptionForeground);
            font-size: 10px;
            white-space: nowrap;
            max-width: 132px;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        button {
            min-height: 30px;
            padding: 6px 8px;
            color: var(--vscode-button-foreground);
            background: var(--vscode-button-background);
            border: 0;
            border-radius: 4px;
            cursor: pointer;
            text-align: center;
            font: inherit;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        button:hover {
            background: var(--vscode-button-hoverBackground);
        }

        button:disabled {
            cursor: default;
            opacity: 0.65;
        }

        .transcript {
            flex: 1 1 auto;
            min-height: 0;
            overflow-y: auto;
            border: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
            border-radius: 6px;
            padding: 10px;
            background: var(--vscode-editor-background);
        }

        .agent-plan {
            display: none;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 8px;
            background: var(--vscode-editor-background);
        }

        .agent-plan.visible {
            display: block;
        }

        .agent-plan-title {
            margin-bottom: 6px;
            font-size: 11px;
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
        }

        .agent-step {
            display: grid;
            grid-template-columns: 18px 1fr;
            gap: 6px;
            align-items: start;
            margin-top: 4px;
            line-height: 1.35;
        }

        .agent-step-status {
            color: var(--vscode-descriptionForeground);
            text-align: center;
        }

        .timeline-event {
            display: grid;
            grid-template-columns: 18px 1fr;
            gap: 6px;
            padding: 5px 0;
            border-top: 1px solid var(--vscode-panel-border);
        }

        .timeline-event:first-of-type {
            border-top: 0;
        }

        .timeline-title {
            font-weight: 600;
        }

        .timeline-detail {
            margin-top: 2px;
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            line-height: 1.35;
            overflow-wrap: anywhere;
        }

        .message {
            display: grid;
            gap: 5px;
            line-height: 1.4;
            margin-bottom: 14px;
        }

        .message:last-child {
            margin-bottom: 0;
        }

        .role {
            display: block;
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0;
        }

        .bubble {
            box-sizing: border-box;
            width: 100%;
            padding: 9px 10px;
            border-radius: 6px;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
        }

        .message.user .bubble {
            background: var(--vscode-inputOption-activeBackground);
            border: 1px solid var(--vscode-inputOption-activeBorder);
        }

        .message.assistant .bubble {
            background: var(--vscode-sideBar-background);
            border: 1px solid var(--vscode-panel-border);
        }

        .message.error .bubble {
            background: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
        }

        .empty {
            display: grid;
            place-items: center;
            min-height: 100%;
            color: var(--vscode-descriptionForeground);
            text-align: center;
            line-height: 1.45;
        }

        pre {
            margin: 8px 0 0;
            padding: 9px;
            overflow-x: auto;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            background: var(--vscode-textCodeBlock-background);
        }

        code {
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
            white-space: pre;
        }

        textarea {
            box-sizing: border-box;
            width: 100%;
            min-height: 84px;
            max-height: 180px;
            resize: vertical;
            padding: 8px;
            color: var(--vscode-input-foreground);
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            font-family: var(--vscode-font-family);
            font: inherit;
        }

        .composer {
            display: grid;
            gap: 8px;
            flex: 0 0 auto;
        }

        .composer-row {
            display: grid;
            grid-template-columns: repeat(5, minmax(0, 1fr));
            align-items: stretch;
            gap: 6px;
        }

        .composer-row button {
            min-width: 0;
            width: 100%;
            padding-left: 5px;
            padding-right: 5px;
            font-size: 11px;
        }

        .hint {
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            line-height: 1.35;
        }

        .secondary {
            color: var(--vscode-button-secondaryForeground);
            background: var(--vscode-button-secondaryBackground);
        }

        .secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        .toolbar {
            display: grid;
            grid-template-columns: repeat(5, minmax(0, 1fr));
            gap: 6px;
            align-items: center;
            flex: 0 0 auto;
        }

        .toolbar button {
            width: 100%;
            min-height: 26px;
            padding: 4px 8px;
            font-size: 11px;
        }

        .model-select {
            width: 100%;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        @media (max-width: 250px) {
            .shell {
                padding: 8px;
            }

            .toolbar {
                grid-template-columns: 1fr;
            }

            .composer-row {
                grid-template-columns: 1fr;
            }
        }

    </style>
    <title>Codestral</title>
</head>
<body>
    <div class="shell">
        <header>
            <div class="brand">
                <img src="${logoUri}" alt="">
                <h2>Codestral</h2>
            </div>
            <div class="header-meta">
                <span class="status">${uiText.ready}</span>
                <span class="usage" id="usage" title="${uiText.tokens}">${uiText.tokens}: -</span>
            </div>
        </header>

        <div class="toolbar" aria-label="Actions Codestral">
            <button class="secondary" data-command="codestral-ai.setApiKey" title="${uiText.key}">${uiText.key}</button>
            <button class="secondary" data-command="codestral-ai.showAvailableModels" title="${uiText.models}">${uiText.models}</button>
            <button class="secondary" data-command="codestral-ai.stopAgentCommand" title="${uiText.stop}">${uiText.stop}</button>
            <button class="secondary" data-command="codestral-ai.rerunAgentCommand" title="${uiText.rerun}">${uiText.rerun}</button>
            <button class="secondary" data-command="codestral-ai.openSettingsMenu" title="${uiText.settingsTitle}">⚙</button>
        </div>

        <div id="agentPlan" class="agent-plan"></div>

        <div id="transcript" class="transcript">
            <div class="empty">${uiText.empty}</div>
        </div>

        <div class="composer">
            <textarea id="input" placeholder="${uiText.placeholder}"></textarea>
            <div class="hint">${uiText.hint}</div>
            <div class="composer-row">
                <button class="secondary model-select" id="modelSelect" data-command="codestral-ai.selectModel">${uiText.model}</button>
                <button class="secondary" id="history" data-command="codestral-ai.showChatHistory" title="${uiText.historyTitle}">${uiText.history}</button>
                <button class="secondary" id="clear">${uiText.newChat}</button>
                <button class="secondary" id="agent">${uiText.agent}</button>
                <button id="send">${uiText.send}</button>
            </div>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const transcript = document.getElementById('transcript');
        const input = document.getElementById('input');
        const send = document.getElementById('send');
        const agent = document.getElementById('agent');
        const clear = document.getElementById('clear');
        const modelSelect = document.getElementById('modelSelect');
        const status = document.querySelector('.status');
        const usage = document.getElementById('usage');
        const agentPlan = document.getElementById('agentPlan');
        const initialHistory = ${initialHistory};
        const initialModel = ${initialModel};
        const initialTokenUsage = ${initialTokenUsage};
        const uiText = ${initialUiText};
        let pendingMessage = null;

        function updateModelLabel(modelName) {
            const label = modelName || 'codestral-latest';
            const compact = label.length > 11 ? label.slice(0, 10) + '…' : label;
            modelSelect.textContent = compact;
            modelSelect.title = uiText.activeModel + ': ' + label;
        }

        function setBusy(isBusy) {
            send.disabled = isBusy;
            status.textContent = isBusy ? uiText.thinking : uiText.ready;
        }

        function updateTokenUsage(tokenUsage) {
            if (!tokenUsage) {
                usage.textContent = uiText.tokens + ': -';
                return;
            }

            const inputTokens = tokenUsage.prompt_tokens ?? tokenUsage.input_tokens ?? tokenUsage.promptTokens ?? tokenUsage.inputTokens ?? 0;
            const outputTokens = tokenUsage.completion_tokens ?? tokenUsage.output_tokens ?? tokenUsage.completionTokens ?? tokenUsage.outputTokens ?? 0;
            const totalTokens = tokenUsage.total_tokens ?? tokenUsage.totalTokens ?? (inputTokens + outputTokens);
            const text = uiText.tokens + ': ' + inputTokens + ' / ' + outputTokens + ' / ' + totalTokens;
            usage.textContent = text;
            usage.title = text;
        }

        function removeEmptyState() {
            const empty = transcript.querySelector('.empty');
            if (empty) {
                empty.remove();
            }
        }

        function renderContent(container, text) {
            const source = text || '';
            const pattern = new RegExp('\\x60\\x60\\x60([\\\\s\\\\S]*?)\\x60\\x60\\x60', 'g');
            let lastIndex = 0;
            let match;

            while ((match = pattern.exec(source)) !== null) {
                if (match.index > lastIndex) {
                    const paragraph = document.createElement('div');
                    paragraph.textContent = source.slice(lastIndex, match.index);
                    container.appendChild(paragraph);
                }

                const pre = document.createElement('pre');
                const code = document.createElement('code');
                code.textContent = match[1].trim();
                pre.appendChild(code);
                container.appendChild(pre);
                lastIndex = pattern.lastIndex;
            }

            if (lastIndex < source.length || container.childElementCount === 0) {
                const paragraph = document.createElement('div');
                paragraph.textContent = source.slice(lastIndex);
                container.appendChild(paragraph);
            }
        }

        function appendMessage(role, text, kind) {
            removeEmptyState();
            const message = document.createElement('div');
            message.className = 'message ' + kind;

            const label = document.createElement('span');
            label.className = 'role';
            label.textContent = role;

            const content = document.createElement('div');
            content.className = 'bubble';
            renderContent(content, text);

            message.appendChild(label);
            message.appendChild(content);
            transcript.appendChild(message);
            transcript.scrollTop = transcript.scrollHeight;
            return message;
        }

        function renderHistory(items) {
            transcript.innerHTML = '';
            pendingMessage = null;
            setBusy(false);

            if (!items || items.length === 0) {
                transcript.innerHTML = '<div class="empty">' + uiText.empty + '</div>';
                return;
            }

            items.forEach((item) => {
                appendMessage(item.role, item.text, item.kind);
            });
        }

        function renderAgentPlan(title, steps) {
            agentPlan.classList.add('visible');
            agentPlan.innerHTML = '';

            const heading = document.createElement('div');
            heading.className = 'agent-plan-title';
            heading.textContent = title;
            agentPlan.appendChild(heading);

            steps.forEach((step) => {
                const row = document.createElement('div');
                row.className = 'agent-step';

                const state = document.createElement('span');
                state.className = 'agent-step-status';
                state.textContent = step.status;

                const label = document.createElement('span');
                label.textContent = step.label;

                row.appendChild(state);
                row.appendChild(label);
                agentPlan.appendChild(row);
            });
        }

        function renderAgentTimeline(title, events) {
            agentPlan.classList.add('visible');
            agentPlan.innerHTML = '';

            const heading = document.createElement('div');
            heading.className = 'agent-plan-title';
            heading.textContent = title;
            agentPlan.appendChild(heading);

            events.forEach((event) => {
                const row = document.createElement('div');
                row.className = 'timeline-event';

                const state = document.createElement('span');
                state.className = 'agent-step-status';
                state.textContent = event.status;

                const body = document.createElement('div');
                const titleEl = document.createElement('div');
                titleEl.className = 'timeline-title';
                titleEl.textContent = event.phase;
                body.appendChild(titleEl);

                if (event.detail) {
                    const detail = document.createElement('div');
                    detail.className = 'timeline-detail';
                    detail.textContent = event.detail;
                    body.appendChild(detail);
                }

                row.appendChild(state);
                row.appendChild(body);
                agentPlan.appendChild(row);
            });
        }

        renderHistory(initialHistory);
        updateModelLabel(initialModel);
        updateTokenUsage(initialTokenUsage);

        function sendMessage() {
            const text = input.value.trim();
            if (!text) {
                return;
            }

            appendMessage('Vous', text, 'user');
            input.value = '';
            vscode.postMessage({ command: 'codestral-ai.sidebarChat', text });
        }

        function sendAgentTask() {
            const text = input.value.trim();
            if (!text) {
                return;
            }

            appendMessage('Vous', text, 'user');
            input.value = '';
            vscode.postMessage({ command: 'codestral-ai.sidebarAgent', text });
        }

        document.querySelectorAll('button[data-command]').forEach((button) => {
            button.addEventListener('click', () => {
                vscode.postMessage({ command: button.dataset.command });
            });
        });

        send.addEventListener('click', sendMessage);
        agent.addEventListener('click', sendAgentTask);
        clear.addEventListener('click', () => {
            input.value = '';
            vscode.postMessage({ command: 'codestral-ai.newChat' });
        });

        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
            }
        });

        window.addEventListener('message', (event) => {
            const message = event.data;
            if (message.type === 'pending') {
                setBusy(true);
                pendingMessage = appendMessage('Codestral', '...', 'assistant');
            }

            if (message.type === 'answer' || message.type === 'error') {
                if (pendingMessage) {
                    pendingMessage.remove();
                    pendingMessage = null;
                }

                setBusy(false);
                appendMessage(
                    message.type === 'error' ? 'Erreur' : 'Codestral',
                    message.text,
                    message.type === 'error' ? 'error' : 'assistant'
                );
            }

            if (message.type === 'historyItem') {
                appendMessage(message.item.role, message.item.text, message.item.kind);
            }

            if (message.type === 'agentPlan') {
                renderAgentPlan(message.title, message.steps);
            }

            if (message.type === 'agentTimeline') {
                renderAgentTimeline(message.title, message.events);
            }

            if (message.type === 'model') {
                updateModelLabel(message.model);
            }

            if (message.type === 'history') {
                renderHistory(message.items);
            }

            if (message.type === 'tokenUsage') {
                updateTokenUsage(message.usage);
            }
        });
    </script>
</body>
</html>`;
    }
}

function createChatSession(items: ChatHistoryItem[]): ChatSession {
    const now = Date.now();
    return {
        id: `${now}-${Math.random().toString(36).slice(2, 9)}`,
        title: buildChatSessionTitle(items),
        items,
        updatedAt: now
    };
}

function buildChatSessionTitle(items: ChatHistoryItem[]): string {
    const firstUserMessage = items.find(item => item.kind === 'user')?.text.trim();
    if (!firstUserMessage) {
        return 'Nouvelle conversation';
    }

    const firstLine = firstUserMessage.replace(/\s+/g, ' ').slice(0, 60);
    return firstLine || 'Nouvelle conversation';
}

function buildFollowUpAgentTask(
    text: string,
    history: ChatHistoryItem[],
    lastAssistantText = ''
): string | undefined {
    if (!isAgentConfirmationRequest(text)) {
        return undefined;
    }

    const recentHistory = [
        ...history,
        ...(lastAssistantText.trim()
            ? [{ role: 'Codestral' as const, text: lastAssistantText, kind: 'assistant' as const }]
            : [])
    ]
        .slice(-8)
        .filter(item => item.text.trim().length > 0);
    if (recentHistory.length === 0) {
        return text;
    }

    const hasActionableProposal = recentHistory.some(item => {
        const value = item.text.toLowerCase();
        return /(?:fichier|file|index\.html|styles?\.css|script\.js|package\.json|```|<html|function|class|const|let|body\s*\{|:root\s*\{)/i.test(value);
    });
    const hasPreviousWriteIntent = recentHistory.some(item => item.kind === 'user' && isWorkspaceWriteRequest(item.text));

    if (!hasActionableProposal && !hasPreviousWriteIntent) {
        return [
            'L’utilisateur confirme une action précédente mais l’historique est incomplet.',
            'Passe en mode agent. Inspecte le workspace et applique la modification la plus probable demandée récemment.',
            '',
            `Message utilisateur: ${text}`
        ].join('\n');
    }

    const context = recentHistory
        .map(item => `${item.role}:\n${item.text}`)
        .join('\n\n---\n\n')
        .slice(-22000);

    return [
        'L’utilisateur confirme qu’il faut appliquer/coder la proposition précédente.',
        'Passe en mode agent et modifie réellement les fichiers du workspace.',
        'Déduis les fichiers à créer ou modifier à partir de l’historique récent.',
        'Ne réponds pas seulement avec du code: produis un patch agent applicable.',
        '',
        `Message de confirmation utilisateur: ${text}`,
        '',
        'Historique récent utile:',
        context
    ].join('\n');
}

function isAgentConfirmationRequest(text: string): boolean {
    const normalized = text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();

    if (!normalized) {
        return false;
    }

    return /^(ok|oui|yes|go|vas y|vasy|allez|lance toi|lance le|lance|fait le|fais le|applique|execute|mets le|met le|code le|cree le|corrige le|modifie le|continue|c est bon|cest bon)(\b|$)/.test(normalized)
        || /\b(lance toi|vas y|vasy|applique|fais le|fait le|execute|mode agent|agent)\b/.test(normalized);
}

function shouldStartAgentLocally(text: string, history: ChatHistoryItem[] = []): boolean {
    if (isWorkspaceWriteRequest(text)) {
        return true;
    }

    const normalized = normalizeIntentText(text);
    const recentUserText = history
        .filter(item => item.kind === 'user')
        .slice(-3)
        .map(item => normalizeIntentText(item.text))
        .join(' ');

    const asksForSiteChange = /\b(site|website|page|html|css|style|styles|portfolio|vitrine|landing)\b/.test(normalized)
        && /\b(ameliore|ameliorer|aamolir|amolir|modernise|moderniser|moderne|plus moderne|ajoute|changer|change|refais|refaire|rends|rendre)\b/.test(normalized);
    const asksForExistingProposalApply = isAgentConfirmationRequest(text)
        && /\b(site|page|html|css|styles|fichier|projet|modifier|ameliorer|moderniser)\b/.test(recentUserText);

    return asksForSiteChange || asksForExistingProposalApply;
}

function isWorkspaceWriteRequest(text: string): boolean {
    const normalized = normalizeIntentText(text);
    const compact = normalized.replace(/[^a-z0-9.]+/g, ' ');
    const words = compact.split(/\s+/).filter(Boolean);

    const writeWords = [
        'cree', 'creer', 'create', 'genere', 'generer', 'generate', 'ajoute', 'ajouter', 'add',
        'modifie', 'modifier', 'modify', 'corrige', 'corriger', 'fix', 'supprime', 'supprimer',
        'delete', 'remove', 'scaffold', 'implemente', 'implementer', 'implement', 'refactor', 'refactorise',
        'mdiofie', 'modfi', 'modfie', 'mofidie', 'change', 'changer', 'edit', 'edite',
        'ameliore', 'ameliorer', 'amelioration', 'aamolir', 'amolir', 'modernise', 'moderniser',
        'modern', 'moderne', 'refais', 'refaire', 'rends', 'rendre'
    ];
    const targetWords = [
        'fichier', 'file', 'projet', 'project', 'app', 'application', 'page', 'component', 'composant',
        'route', 'test', 'dossier', 'folder', 'workspace', 'html', 'css', 'js', 'javascript', 'python',
        'fichierrs', 'fichire', 'ficher', 'fcihier', 'fciochier', 'agent', 'agents', 'gent', 'gants',
        'site', 'website', 'portfolio', 'vitrine', 'landing', 'style', 'styles'
    ];
    const readWords = [
        'explique', 'expliquer', 'explain', 'resume', 'resumer', 'summarize', 'pourquoi', 'why',
        'comment', 'how', 'lis', 'lire', 'read'
    ];

    const hasWriteVerb = words.some(word => fuzzyIncludes(word, writeWords))
        || /\b(c+r+e+|c+r+e+r+|c+r+r+e+|c+c+r+e+r+|m+d+i*o*f+i*e*|a+m+o*l+i*r+|a+m+e*l+i*o*r+|modern\w*|fai[st]?|make|build)\b/.test(normalized)
        || /\b(mode|passer|passe|lance|lancer)\b.*\b(agent|agents|gent|gants)\b/.test(normalized);
    const hasTarget = words.some(word => fuzzyIncludes(word, targetWords))
        || /[\w./-]+\.[a-z0-9]{1,8}/i.test(text);
    const readOnlyIntent = words.some(word => fuzzyIncludes(word, readWords));

    return hasWriteVerb && hasTarget && !readOnlyIntent;
}

function normalizeIntentText(text: string): string {
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}

async function routeSidebarIntent(
    apiKey: string,
    userMessage: string,
    editorContext: string,
    model: string
): Promise<IntentRoute> {
    if (isWorkspaceWriteRequest(userMessage)) {
        return {
            route: 'agent',
            reason: 'la demande ressemble à une création ou modification de fichiers'
        };
    }

    const prompt = [
        'Tu es le routeur d’intention d’une extension de code type Codex.',
        'Classe la demande utilisateur.',
        'Réponds uniquement avec un JSON valide, sans Markdown.',
        '',
        'Routes possibles:',
        '- "agent": créer, modifier, supprimer, déplacer ou refactorer des fichiers; créer un projet; lancer une implémentation; corriger du code dans le workspace.',
        '- "explain": expliquer ou résumer le fichier courant sans modifier.',
        '- "review": relire/analyser le projet ou fichier sans modifier.',
        '- "chat": répondre à une question générale sans toucher aux fichiers.',
        '',
        'Important:',
        '- Les fautes de frappe sont fréquentes. Déduis l’intention même si les mots sont mal écrits.',
        '- Si l’utilisateur demande “fais-le”, “applique”, “modifie”, “corrige”, “crée”, “ajoute”, “supprime”, ou parle de passer en agent, choisis "agent".',
        '- Si la demande implique d’écrire sur disque, choisis toujours "agent".',
        '',
        'Schéma:',
        '{ "route": "chat|agent|explain|review", "reason": "raison courte" }',
        '',
        editorContext ? `Contexte fichier actif:\n${editorContext.slice(0, 1800)}` : 'Aucun fichier actif connu.',
        '',
        `Message utilisateur:\n${userMessage}`
    ].join('\n');

    try {
        const raw = await callCodestralChat(apiKey, prompt, 180, 0, model);
        return parseIntentRoute(raw) ?? {
            route: isWorkspaceWriteRequest(userMessage) ? 'agent' : 'chat',
            reason: 'routeur illisible, fallback local'
        };
    } catch {
        return {
            route: isWorkspaceWriteRequest(userMessage) ? 'agent' : 'chat',
            reason: 'routeur indisponible, fallback local'
        };
    }
}

function parseIntentRoute(raw: string): IntentRoute | undefined {
    const trimmed = raw.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1].trim() : trimmed;
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    const jsonText = firstBrace >= 0 && lastBrace > firstBrace
        ? candidate.slice(firstBrace, lastBrace + 1)
        : candidate;

    try {
        const parsed = JSON.parse(jsonText) as Partial<IntentRoute>;
        const route = parsed.route;
        if (route !== 'chat' && route !== 'agent' && route !== 'explain' && route !== 'review') {
            return undefined;
        }

        return {
            route,
            reason: String(parsed.reason || '')
        };
    } catch {
        return undefined;
    }
}

function fuzzyIncludes(word: string, candidates: string[]): boolean {
    return candidates.some(candidate => {
        if (word === candidate || word.includes(candidate) || candidate.includes(word)) {
            return true;
        }

        if (word.length < 4 || candidate.length < 4) {
            return false;
        }

        return levenshteinDistance(word, candidate) <= Math.max(1, Math.floor(candidate.length * 0.35));
    });
}

function levenshteinDistance(a: string, b: string): number {
    const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));

    for (let i = 0; i <= a.length; i++) {
        dp[i][0] = i;
    }

    for (let j = 0; j <= b.length; j++) {
        dp[0][j] = j;
    }

    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + cost
            );
        }
    }

    return dp[a.length][b.length];
}

function getUiText(language: string | undefined): UiText {
    const key = (language || 'français').trim().toLowerCase();
    const texts: Record<string, UiText> = {
        'français': {
            htmlLang: 'fr',
            ready: 'Prêt',
            thinking: 'Réflexion',
            empty: 'Codestral est prêt.',
            placeholder: 'Décris ce que tu veux coder, corriger, tester ou comprendre...',
            hint: 'Écris une demande. Les commandes avancées restent dans Ctrl+Shift+P.',
            key: 'API',
            models: 'Mod',
            stop: 'Stop',
            rerun: 'Run',
            settingsTitle: 'Paramètres Codestral',
            model: 'Modèle',
            history: 'Hist',
            historyTitle: 'Historique des chats',
            newChat: 'New',
            agent: 'Agent',
            send: 'Send',
            activeModel: 'Modèle actif',
            tokens: 'Tok'
        },
        'anglais': {
            htmlLang: 'en',
            ready: 'Ready',
            thinking: 'Thinking',
            empty: 'Codestral is ready.',
            placeholder: 'Describe what you want to code, fix, test, or understand...',
            hint: 'Write a request. Advanced commands stay in Ctrl+Shift+P.',
            key: 'API',
            models: 'Mod',
            stop: 'Stop',
            rerun: 'Run',
            settingsTitle: 'Codestral settings',
            model: 'Model',
            history: 'Hist',
            historyTitle: 'Chat history',
            newChat: 'New',
            agent: 'Agent',
            send: 'Send',
            activeModel: 'Active model',
            tokens: 'Tok'
        },
        'arabe': {
            htmlLang: 'ar',
            ready: 'جاهز',
            thinking: 'يفكر',
            empty: 'Codestral جاهز.',
            placeholder: 'اكتب ما تريد برمجته أو إصلاحه أو اختباره...',
            hint: 'اكتب طلبك. الأوامر المتقدمة في Ctrl+Shift+P.',
            key: 'API',
            models: 'Mod',
            stop: 'Stop',
            rerun: 'Run',
            settingsTitle: 'إعدادات Codestral',
            model: 'Model',
            history: 'Hist',
            historyTitle: 'سجل المحادثات',
            newChat: 'New',
            agent: 'Agent',
            send: 'Send',
            activeModel: 'النموذج النشط',
            tokens: 'Tok'
        },
        'espagnol': {
            htmlLang: 'es',
            ready: 'Listo',
            thinking: 'Pensando',
            empty: 'Codestral está listo.',
            placeholder: 'Describe lo que quieres programar, corregir, probar o entender...',
            hint: 'Escribe una petición. Los comandos avanzados están en Ctrl+Shift+P.',
            key: 'API',
            models: 'Mod',
            stop: 'Stop',
            rerun: 'Run',
            settingsTitle: 'Ajustes de Codestral',
            model: 'Modelo',
            history: 'Hist',
            historyTitle: 'Historial de chats',
            newChat: 'New',
            agent: 'Agent',
            send: 'Send',
            activeModel: 'Modelo activo',
            tokens: 'Tok'
        },
        'allemand': {
            htmlLang: 'de',
            ready: 'Bereit',
            thinking: 'Denkt',
            empty: 'Codestral ist bereit.',
            placeholder: 'Beschreibe, was du coden, korrigieren, testen oder verstehen willst...',
            hint: 'Schreibe eine Anfrage. Erweiterte Befehle bleiben in Ctrl+Shift+P.',
            key: 'API',
            models: 'Mod',
            stop: 'Stop',
            rerun: 'Run',
            settingsTitle: 'Codestral Einstellungen',
            model: 'Modell',
            history: 'Hist',
            historyTitle: 'Chatverlauf',
            newChat: 'New',
            agent: 'Agent',
            send: 'Send',
            activeModel: 'Aktives Modell',
            tokens: 'Tok'
        },
        'italien': {
            htmlLang: 'it',
            ready: 'Pronto',
            thinking: 'Pensa',
            empty: 'Codestral è pronto.',
            placeholder: 'Descrivi cosa vuoi programmare, correggere, testare o capire...',
            hint: 'Scrivi una richiesta. I comandi avanzati restano in Ctrl+Shift+P.',
            key: 'API',
            models: 'Mod',
            stop: 'Stop',
            rerun: 'Run',
            settingsTitle: 'Impostazioni Codestral',
            model: 'Modello',
            history: 'Hist',
            historyTitle: 'Cronologia chat',
            newChat: 'New',
            agent: 'Agent',
            send: 'Send',
            activeModel: 'Modello attivo',
            tokens: 'Tok'
        },
        'portugais': {
            htmlLang: 'pt',
            ready: 'Pronto',
            thinking: 'Pensando',
            empty: 'Codestral está pronto.',
            placeholder: 'Descreve o que queres programar, corrigir, testar ou entender...',
            hint: 'Escreve um pedido. Comandos avançados ficam em Ctrl+Shift+P.',
            key: 'API',
            models: 'Mod',
            stop: 'Stop',
            rerun: 'Run',
            settingsTitle: 'Definições Codestral',
            model: 'Modelo',
            history: 'Hist',
            historyTitle: 'Histórico de chats',
            newChat: 'New',
            agent: 'Agent',
            send: 'Send',
            activeModel: 'Modelo ativo',
            tokens: 'Tok'
        }
    };

    return texts[key] ?? texts['français'];
}

export async function activate(context: vscode.ExtensionContext) {
    extensionContextRef = context;
    lastSidebarAssistantText = context.globalState.get<string>('lastSidebarAssistantText') ?? '';
    lastTokenUsage = context.globalState.get<TokenUsage | undefined>('lastTokenUsage');
    lastActiveTextEditor = vscode.window.activeTextEditor;
    // Lire la configuration
    const config = vscode.workspace.getConfiguration('codestral-ai');
    let apiKey = await context.secrets.get('codestral-api-key') ?? '';
    
    // Migration depuis l'ancien stockage non secret.
    const apiKeyStore = context.globalState;
    const fallbackKey = apiKeyStore.get<string>('apiKeyFallback', '');
    const legacyKey = apiKeyStore.get<string>('apiKey') || config.get<string>('apiKey', '') || fallbackKey;
    if (!apiKey && legacyKey) {
        apiKey = legacyKey;
        await context.secrets.store('codestral-api-key', legacyKey);
        await apiKeyStore.update('apiKeyFallback', legacyKey);
        await apiKeyStore.update('apiKey', undefined);
        await config.update('apiKey', undefined, vscode.ConfigurationTarget.Global);
    }
    const diffProvider = new AgentDiffContentProvider();
    const outputChannel = vscode.window.createOutputChannel('Codestral Agent');
    let lastAgentRun = context.globalState.get<AgentRunState | undefined>('lastAgentRun');
    let agentRunHistory = context.globalState.get<AgentRunRecord[]>('agentRunHistory', []);
    const legacyChatHistory = context.globalState.get<ChatHistoryItem[]>('chatHistory', []);
    let chatSessions = context.globalState.get<ChatSession[]>('chatSessions', []);
    let currentChatSessionId = context.globalState.get<string>('currentChatSessionId', '');
    if (chatSessions.length === 0 && legacyChatHistory.length > 0) {
        const migratedSession = createChatSession(legacyChatHistory);
        chatSessions = [migratedSession];
        currentChatSessionId = migratedSession.id;
    }

    if (chatSessions.length === 0) {
        const emptySession = createChatSession([]);
        chatSessions = [emptySession];
        currentChatSessionId = emptySession.id;
    }

    if (!chatSessions.some(session => session.id === currentChatSessionId)) {
        currentChatSessionId = chatSessions[0].id;
    }
    let chatHistory = chatSessions.find(session => session.id === currentChatSessionId)?.items ?? [];
    workspaceIndexCache = context.globalState.get<WorkspaceIndexEntry[]>('workspaceIndex', []);
    const saveChatSessions = async (sessions: ChatSession[]) => {
        chatSessions = sessions;
        await context.globalState.update('chatSessions', sessions);
    };
    const setCurrentChatSessionId = async (sessionId: string) => {
        currentChatSessionId = sessionId;
        chatHistory = chatSessions.find(session => session.id === sessionId)?.items ?? [];
        await context.globalState.update('currentChatSessionId', sessionId);
        await context.globalState.update('chatHistory', chatHistory);
    };
    const saveCurrentChatHistory = async (history: ChatHistoryItem[]) => {
        chatHistory = history;
        let sessions = chatSessions.filter(session => session.id !== currentChatSessionId);
        const currentSession = chatSessions.find(session => session.id === currentChatSessionId) ?? createChatSession([]);
        const updatedSession: ChatSession = {
            ...currentSession,
            id: currentChatSessionId || currentSession.id,
            title: buildChatSessionTitle(history),
            items: history,
            updatedAt: Date.now()
        };
        currentChatSessionId = updatedSession.id;
        sessions = [updatedSession, ...sessions].slice(0, 50);
        await saveChatSessions(sessions);
        await context.globalState.update('currentChatSessionId', currentChatSessionId);
        await context.globalState.update('chatHistory', history);
    };
    const sidebarProvider = new CodestralSidebarProvider(
        context.extensionUri,
        () => apiKey,
        () => vscode.workspace.getConfiguration('codestral-ai'),
        () => chatHistory,
        saveCurrentChatHistory,
        () => chatSessions,
        saveChatSessions,
        () => currentChatSessionId,
        setCurrentChatSessionId
    );
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('codestral-agent', diffProvider),
        outputChannel,
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) {
                lastActiveTextEditor = editor;
            }
        })
    );

    // Commande pour définir la clé API
    const setApiKeyCommand = vscode.commands.registerCommand('codestral-ai.setApiKey', async () => {
        const action = await vscode.window.showQuickPick(
            [
                {
                    label: 'Entrer la clé API',
                    description: 'Coller et enregistrer la clé Codestral'
                },
                {
                    label: 'Ouvrir la console Mistral',
                    description: 'https://console.mistral.ai/codestral'
                }
            ],
            {
                title: 'Codestral: API Key',
                placeHolder: 'Configurer la clé ou ouvrir la console Mistral'
            }
        );

        if (!action) {
            return;
        }

        if (action.label === 'Ouvrir la console Mistral') {
            await vscode.env.openExternal(vscode.Uri.parse('https://console.mistral.ai/codestral'));
            return;
        }

        const savedApiKey = apiKey
            || await context.secrets.get('codestral-api-key')
            || apiKeyStore.get<string>('apiKeyFallback', '');
        const input = await vscode.window.showInputBox({
            prompt: 'Entrez votre clé API Codestral. Si besoin: https://console.mistral.ai/codestral',
            password: true,
            value: savedApiKey || ''
        });
        
        if (input) {
            apiKey = input;
            try {
                await context.secrets.store('codestral-api-key', apiKey);
                const savedSecret = await context.secrets.get('codestral-api-key');
                if (savedSecret !== apiKey) {
                    await apiKeyStore.update('apiKeyFallback', apiKey);
                }
            } catch {
                await apiKeyStore.update('apiKeyFallback', apiKey);
            }
            await apiKeyStore.update('apiKeyFallback', apiKey);
            await apiKeyStore.update('apiKey', undefined);
            await config.update('apiKey', undefined, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage('Clé API Codestral enregistrée avec succès !');
        }
    });

    const ensureApiKeyForModelList = async (): Promise<string | undefined> => {
        apiKey = apiKey
            || await context.secrets.get('codestral-api-key')
            || apiKeyStore.get<string>('apiKeyFallback', '');
        if (apiKey) {
            return apiKey;
        }

        await vscode.commands.executeCommand('codestral-ai.setApiKey');
        return apiKey || undefined;
    };

    const pickAndActivateModel = async (useLiveModels: boolean): Promise<void> => {
        const currentConfig = vscode.workspace.getConfiguration('codestral-ai');
        const currentModel = currentConfig.get<string>('model', 'codestral-latest');
        const configuredModels = currentConfig.get<string[]>('experimentalModels', []);
        let choices = Array.from(new Set([currentModel, ...configuredModels, 'codestral-latest'])).filter(Boolean);
        let title = 'Codestral: Select Model';

        if (useLiveModels) {
            const currentApiKey = await ensureApiKeyForModelList();
            if (!currentApiKey) {
                vscode.window.showErrorMessage('Clé API Codestral non configurée.');
                return;
            }

            try {
                const liveModels = await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'Codestral: récupération des modèles disponibles...',
                    cancellable: false
                }, async () => listMistralModels(currentApiKey));

                if (liveModels.length > 0) {
                    choices = Array.from(new Set([currentModel, ...liveModels])).filter(Boolean);
                    title = `Codestral: ${liveModels.length} modèle(s) disponible(s)`;
                    await currentConfig.update('experimentalModels', liveModels, vscode.ConfigurationTarget.Global);
                }
            } catch (error) {
                vscode.window.showWarningMessage(`Impossible de récupérer les modèles: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        const model = await vscode.window.showQuickPick(
            [...choices, 'Autre...'],
            {
                title,
                placeHolder: 'Choisis un modèle ou saisis un autre nom'
            }
        );

        const finalModel = model === 'Autre...'
            ? await vscode.window.showInputBox({
                prompt: 'Nom du modèle Mistral/Codestral',
                value: currentModel
            })
            : model;

        if (!finalModel) {
            return;
        }

        await currentConfig.update('model', finalModel, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Modèle Codestral actif: ${finalModel}`);
    };

    const selectModelCommand = vscode.commands.registerCommand('codestral-ai.selectModel', async () => {
        await pickAndActivateModel(false);
    });

    const showAvailableModelsCommand = vscode.commands.registerCommand('codestral-ai.showAvailableModels', async () => {
        await pickAndActivateModel(true);
    });

    const openSettingsMenuCommand = vscode.commands.registerCommand('codestral-ai.openSettingsMenu', async () => {
        const currentConfig = vscode.workspace.getConfiguration('codestral-ai');
        const action = await vscode.window.showQuickPick(
            [
                {
                    label: 'Langue de l’interface',
                    description: currentConfig.get<string>('interfaceLanguage', 'français')
                },
                {
                    label: 'Langue des réponses',
                    description: currentConfig.get<string>('responseLanguage', 'français')
                },
                {
                    label: 'Modèle actif',
                    description: currentConfig.get<string>('model', 'codestral-latest')
                },
                {
                    label: 'Serveur dev',
                    description: currentConfig.get<string>('devServerCommand', '') || 'Détection automatique'
                },
                {
                    label: 'Clé API',
                    description: 'Entrer la clé ou ouvrir la console Mistral'
                },
                {
                    label: 'Ouvrir les paramètres VS Code',
                    description: '@ext:codestral-ai'
                }
            ],
            {
                title: 'Codestral: Paramètres',
                placeHolder: 'Choisis un réglage'
            }
        );

        if (!action) {
            return;
        }

        if (action.label === 'Langue de l’interface') {
            const selectedLanguage = await vscode.window.showQuickPick(
                ['français', 'anglais', 'arabe', 'espagnol', 'allemand', 'italien', 'portugais'],
                {
                    title: 'Codestral: Langue de l’interface',
                    placeHolder: 'Choisis la langue visible dans le panneau Codestral'
                }
            );

            if (selectedLanguage) {
                await currentConfig.update('interfaceLanguage', selectedLanguage, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`Interface Codestral: ${selectedLanguage}`);
            }
            return;
        }

        if (action.label === 'Langue des réponses') {
            const selectedLanguage = await vscode.window.showQuickPick(
                ['français', 'anglais', 'arabe', 'espagnol', 'allemand', 'italien', 'portugais', 'Autre...'],
                {
                    title: 'Codestral: Langue des réponses',
                    placeHolder: 'Choisis la langue utilisée par le chat et l’agent'
                }
            );

            const finalLanguage = selectedLanguage === 'Autre...'
                ? await vscode.window.showInputBox({
                    prompt: 'Langue des réponses Codestral',
                    value: currentConfig.get<string>('responseLanguage', 'français')
                })
                : selectedLanguage;

            if (finalLanguage) {
                await currentConfig.update('responseLanguage', finalLanguage, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`Langue Codestral: ${finalLanguage}`);
            }
            return;
        }

        if (action.label === 'Modèle actif') {
            await pickAndActivateModel(false);
            return;
        }

        if (action.label === 'Serveur dev') {
            const selectedAction = await vscode.window.showQuickPick(
                [
                    { label: 'Démarrer', command: 'codestral-ai.startDevServer' },
                    { label: 'Redémarrer', command: 'codestral-ai.restartDevServer' },
                    { label: 'Arrêter', command: 'codestral-ai.stopDevServer' },
                    { label: 'Changer la commande', command: 'configure' }
                ],
                {
                    title: 'Codestral: Serveur dev',
                    placeHolder: 'Gérer le serveur dev du projet'
                }
            );

            if (!selectedAction) {
                return;
            }

            if (selectedAction.command === 'configure') {
                const workspaceRoot = getWorkspaceRoot();
                const defaultCommand = currentConfig.get<string>('devServerCommand', '')
                    || (workspaceRoot ? await detectDevServerCommand(workspaceRoot) : '');
                const command = await vscode.window.showInputBox({
                    prompt: 'Commande serveur dev par défaut',
                    value: defaultCommand
                });

                if (command !== undefined) {
                    await currentConfig.update('devServerCommand', command, vscode.ConfigurationTarget.Workspace);
                }
                return;
            }

            await vscode.commands.executeCommand(selectedAction.command);
            return;
        }

        if (action.label === 'Clé API') {
            await vscode.commands.executeCommand('codestral-ai.setApiKey');
            return;
        }

        await vscode.commands.executeCommand('workbench.action.openSettings', 'codestral-ai');
    });

    const rebuildWorkspaceIndexCommand = vscode.commands.registerCommand('codestral-ai.rebuildWorkspaceIndex', async () => {
        const workspaceRoot = getWorkspaceRoot();
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('Aucun workspace ouvert.');
            return;
        }

        workspaceIndexCache = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Codestral: indexation du workspace...',
            cancellable: false
        }, async () => buildWorkspaceIndex());
        await context.globalState.update('workspaceIndex', workspaceIndexCache);
        vscode.window.showInformationMessage(`Index Codestral mis à jour: ${workspaceIndexCache.length} fichier(s).`);
    });

    const stopAgentCommand = vscode.commands.registerCommand('codestral-ai.stopAgentCommand', async () => {
        if (!activeCommandProcess) {
            vscode.window.showInformationMessage('Aucune commande agent en cours.');
            return;
        }

        activeCommandProcess.kill();
        outputChannel.appendLine('\n[Codestral Agent] Command stopped by user.');
        activeCommandProcess = undefined;
    });

    const rerunAgentCommand = vscode.commands.registerCommand('codestral-ai.rerunAgentCommand', async () => {
        if (!lastShellCommand) {
            vscode.window.showInformationMessage('Aucune commande agent à relancer.');
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Codestral Agent: relance (${lastShellCommand.command})`,
            cancellable: false
        }, async () => runShellCommandDetailed(lastShellCommand!.command, lastShellCommand!.cwd, outputChannel));
    });

    const startDevServerCommand = vscode.commands.registerCommand('codestral-ai.startDevServer', async () => {
        const workspaceRoot = getWorkspaceRoot();
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('Aucun workspace ouvert.');
            return;
        }

        const currentConfig = vscode.workspace.getConfiguration('codestral-ai');
        const configuredCommand = currentConfig.get<string>('devServerCommand', '').trim();
        const detectedCommand = configuredCommand || await detectDevServerCommand(workspaceRoot);
        const command = await vscode.window.showInputBox({
            prompt: 'Commande serveur dev',
            value: detectedCommand,
            placeHolder: 'npm run dev, npm start, python -m http.server 5173...'
        });

        if (!command) {
            return;
        }

        await startDevServer(command, workspaceRoot, outputChannel);
    });

    const stopDevServerCommand = vscode.commands.registerCommand('codestral-ai.stopDevServer', async () => {
        if (!activeDevServerProcess) {
            vscode.window.showInformationMessage('Aucun serveur dev Codestral en cours.');
            return;
        }

        activeDevServerProcess.kill('SIGTERM');
        outputChannel.appendLine('\n[Codestral Dev] Server stopped by user.');
        activeDevServerProcess = undefined;
    });

    const restartDevServerCommand = vscode.commands.registerCommand('codestral-ai.restartDevServer', async () => {
        const workspaceRoot = getWorkspaceRoot();
        const previous = lastDevServerCommand ?? (workspaceRoot
            ? { command: await detectDevServerCommand(workspaceRoot), cwd: workspaceRoot }
            : undefined);

        if (!previous) {
            vscode.window.showInformationMessage('Aucun workspace ouvert pour relancer un serveur dev.');
            return;
        }

        if (activeDevServerProcess) {
            activeDevServerProcess.kill('SIGTERM');
            activeDevServerProcess = undefined;
        }

        await startDevServer(previous.command, previous.cwd, outputChannel);
    });

    const ensureApiKey = async (): Promise<string | undefined> => {
        apiKey = apiKey
            || await context.secrets.get('codestral-api-key')
            || apiKeyStore.get<string>('apiKeyFallback', '');
        if (apiKey) {
            return apiKey;
        }

        await vscode.commands.executeCommand('codestral-ai.setApiKey');
        if (!apiKey) {
            vscode.window.showErrorMessage('Clé API Codestral non configurée.');
            return undefined;
        }

        return apiKey;
    };

    const runAgentPrompt = async (
        title: string,
        prompt: string,
        maxTokensOverride?: number
    ): Promise<string | undefined> => {
        const currentApiKey = await ensureApiKey();
        if (!currentApiKey) {
            return undefined;
        }

        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title,
            cancellable: false
        }, async () => {
            const currentConfig = vscode.workspace.getConfiguration('codestral-ai');
            const maxTokens = maxTokensOverride ?? currentConfig.get<number>('maxTokens', 1000);
            const temperature = currentConfig.get<number>('temperature', 0.3);
            const model = currentConfig.get<string>('model', 'codestral-latest');
            const response = await callCodestralChat(
                currentApiKey,
                withResponseLanguage(prompt, currentConfig),
                maxTokens,
                temperature,
                model
            );
            sidebarProvider.postTokenUsage(lastTokenUsage);
            return response;
        });
    };

    // Commande pour compléter le code
    const completeCodeCommand = vscode.commands.registerCommand('codestral-ai.completeCode', async () => {
        if (!apiKey) {
            vscode.window.showErrorMessage('Clé API Codestral non configurée. Veuillez la définir via la commande "Codestral: Set API Key".');
            return;
        }

        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('Aucun éditeur actif trouvé.');
            return;
        }

        const document = editor.document;
        const selection = editor.selection;
        
        // Récupérer le code sélectionné ou la ligne actuelle
        let prompt: string;
        if (!selection.isEmpty) {
            prompt = document.getText(selection);
        } else {
            const line = document.lineAt(selection.active.line);
            prompt = line.text;
        }

        // Afficher une barre de progression
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Codestral: Complétion de code en cours...',
            cancellable: false
        }, async (progress) => {
            try {
                const maxTokens = config.get<number>('maxTokens', 200);
                const temperature = config.get<number>('temperature', 0.7);
                const model = config.get<string>('model', 'codestral-latest');

                const completion = await callCodestralCompletion(
                    apiKey,
                    prompt,
                    maxTokens,
                    temperature,
                    model
                );

                if (completion) {
                    // Insérer la complétion à la position du curseur
                    await editor.edit(editBuilder => {
                        editBuilder.insert(selection.active, completion);
                    });
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Erreur lors de la complétion: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
    });

    // Commande pour le chat
    const chatCommand = vscode.commands.registerCommand('codestral-ai.chat', async () => {
        if (!apiKey) {
            vscode.window.showErrorMessage('Clé API Codestral non configurée. Veuillez la définir via la commande "Codestral: Set API Key".');
            return;
        }

        const userInput = await vscode.window.showInputBox({
            prompt: 'Posez votre question ou décrivez ce que vous voulez que Codestral fasse:',
            placeHolder: 'Ex: "Comment optimiser cette boucle ?" ou "Génère une fonction pour..."'
        });

        if (!userInput) {
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Codestral: Réponse en cours...',
            cancellable: false
        }, async (progress) => {
            try {
                const maxTokens = config.get<number>('maxTokens', 500);
                const temperature = config.get<number>('temperature', 0.7);
                const model = config.get<string>('model', 'codestral-latest');

                const response = await callCodestralChat(
                    apiKey,
                    withResponseLanguage(userInput, config),
                    maxTokens,
                    temperature,
                    model
                );

                if (response) {
                    // Afficher la réponse dans une nouvelle fenêtre de document
                    const document = await vscode.workspace.openTextDocument({
                        content: `## Codestral AI Response\n\n${response}`,
                        language: 'markdown'
                    });
                    await vscode.window.showTextDocument(document);
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Erreur lors du chat: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
    });

    const explainSelectionCommand = vscode.commands.registerCommand('codestral-ai.explainSelection', async () => {
        const input = getActiveCodeInput(false);
        if (!input) {
            return;
        }

        const response = await runAgentPrompt(
            'Codestral: explication en cours...',
            [
                'Explique ce code de façon claire et structurée.',
                'Signale les parties importantes, les risques et les améliorations possibles.',
                '',
                buildCodeContext(input)
            ].join('\n')
        );

        if (response) {
            await openMarkdownDocument('Codestral Explain', response);
        }
    });

    const fixSelectionCommand = vscode.commands.registerCommand('codestral-ai.fixSelection', async () => {
        const input = getActiveCodeInput(true);
        if (!input) {
            return;
        }

        const response = await runAgentPrompt(
            'Codestral: correction en cours...',
            [
                'Corrige et améliore le code sélectionné.',
                'Réponds uniquement avec le code complet de remplacement, sans explication.',
                '',
                buildCodeContext(input)
            ].join('\n')
        );

        if (!response) {
            return;
        }

        const replacement = extractCodeFromResponse(response);
        const choice = await vscode.window.showWarningMessage(
            'Remplacer la sélection par la correction proposée par Codestral ?',
            { modal: true },
            'Remplacer'
        );

        if (choice !== 'Remplacer') {
            await openMarkdownDocument('Codestral Fix Proposal', response);
            return;
        }

        await input.editor.edit(editBuilder => {
            editBuilder.replace(input.range, replacement);
        });
    });

    const generateTestsCommand = vscode.commands.registerCommand('codestral-ai.generateTests', async () => {
        const input = getActiveCodeInput(false);
        if (!input) {
            return;
        }

        const response = await runAgentPrompt(
            'Codestral: génération de tests...',
            [
                'Génère des tests pertinents pour ce code.',
                'Utilise le framework de test naturel pour ce langage si possible.',
                'Inclue les cas limites et les erreurs probables.',
                '',
                buildCodeContext(input)
            ].join('\n')
        );

        if (response) {
            await openMarkdownDocument('Codestral Tests', response);
        }
    });

    const reviewFileCommand = vscode.commands.registerCommand('codestral-ai.reviewFile', async () => {
        const input = getActiveCodeInput(false);
        if (!input) {
            return;
        }

        const response = await runAgentPrompt(
            'Codestral: revue du fichier...',
            [
                'Fais une revue de code de ce fichier.',
                'Priorise les bugs, les régressions possibles, les risques de sécurité et les tests manquants.',
                'Réponds avec une liste courte et actionnable.',
                '',
                buildCodeContext(input)
            ].join('\n')
        );

        if (response) {
            await openMarkdownDocument('Codestral Review', response);
        }
    });

    const agentTaskCommand = vscode.commands.registerCommand('codestral-ai.agentTask', async (providedTask?: string) => {
        const task = typeof providedTask === 'string' && providedTask.trim()
            ? providedTask.trim()
            : await vscode.window.showInputBox({
                prompt: 'Décris ce que Codestral Agent doit coder',
                placeHolder: 'Ex: Ajoute une page settings, corrige ce bug, crée les tests...'
            });

        if (!task) {
            return;
        }

        const currentApiKey = await ensureApiKey();
        if (!currentApiKey) {
            return;
        }

        const workspaceRoot = getWorkspaceRoot();
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('Aucun workspace ouvert.');
            return;
        }

        const currentConfig = vscode.workspace.getConfiguration('codestral-ai');
        const maxTokens = currentConfig.get<number>('agentMaxTokens', 4000);
        const maxIterations = currentConfig.get<number>('agentMaxIterations', 2);
        let currentTask = task;
        let lastTestOutput = '';
        const agentState: AgentAutonomyState = {
            id: createAgentRunId(),
            task,
            status: 'running',
            iteration: 0,
            maxIterations,
            phase: 'start',
            updatedAt: Date.now()
        };
        await persistAgentAutonomyState(context, workspaceRoot, agentState);
        await sidebarProvider.postAgentUpdate(`Tâche agent démarrée: ${task}`);
        sidebarProvider.postAgentTimeline('Codestral Agent Timeline', [
            { phase: 'Task', status: '●', detail: task },
            { phase: 'Workspace', status: '○', detail: 'Lecture du projet' },
            { phase: 'Patch', status: '○', detail: 'En attente' },
            { phase: 'Validation', status: '○', detail: 'En attente' }
        ]);
        sidebarProvider.postAgentPlan('Codestral Agent', [
            { label: 'Lire le workspace', status: '○' },
            { label: 'Générer le patch', status: '○' },
            { label: 'Afficher les diffs', status: '○' },
            { label: 'Appliquer les fichiers choisis', status: '○' },
            { label: 'Lancer les tests', status: '○' },
            { label: 'Corriger si nécessaire', status: '○' }
        ]);

        for (let iteration = 1; iteration <= maxIterations; iteration++) {
            agentState.iteration = iteration;
            agentState.phase = 'workspace';
            agentState.updatedAt = Date.now();
            await persistAgentAutonomyState(context, workspaceRoot, agentState);
            await sidebarProvider.postAgentUpdate(`Cycle ${iteration}/${maxIterations}: lecture du workspace et génération du patch.`);
            sidebarProvider.postAgentTimeline(`Codestral Agent ${iteration}/${maxIterations}`, [
                { phase: 'Workspace', status: '●', detail: 'Index, mémoire, imports et fichiers liés' },
                { phase: 'Patch', status: '○', detail: 'Génération en attente' },
                { phase: 'Diff', status: '○', detail: 'En attente' },
                { phase: 'Validation', status: '○', detail: 'En attente' }
            ]);
            sidebarProvider.postAgentPlan(`Codestral Agent ${iteration}/${maxIterations}`, [
                { label: 'Lire le workspace', status: '●' },
                { label: 'Générer le patch', status: '○' },
                { label: 'Afficher les diffs', status: '○' },
                { label: 'Appliquer les fichiers choisis', status: '○' },
                { label: 'Lancer les tests', status: '○' },
                { label: 'Corriger si nécessaire', status: '○' }
            ]);
            const workspaceContext = await collectWorkspaceContext(currentTask);
            const prompt = buildAgentPatchPrompt(currentTask, workspaceContext, lastTestOutput);
            agentState.phase = 'patch-generation';
            agentState.updatedAt = Date.now();
            await persistAgentAutonomyState(context, workspaceRoot, agentState);
            sidebarProvider.postAgentPlan(`Codestral Agent ${iteration}/${maxIterations}`, [
                { label: 'Lire le workspace', status: '✓' },
                { label: 'Générer le patch', status: '●' },
                { label: 'Afficher les diffs', status: '○' },
                { label: 'Appliquer les fichiers choisis', status: '○' },
                { label: 'Lancer les tests', status: '○' },
                { label: 'Corriger si nécessaire', status: '○' }
            ]);
            const rawPatch = await runAgentPrompt(
                `Codestral Agent: cycle ${iteration}/${maxIterations}`,
                prompt,
                maxTokens
            );

            if (!rawPatch) {
                agentState.status = 'stopped';
                agentState.phase = 'empty-model-response';
                agentState.updatedAt = Date.now();
                await persistAgentAutonomyState(context, workspaceRoot, agentState);
                return;
            }

            let patch = parseAgentPatch(rawPatch);
            if (!patch) {
                const repairedPatch = await runAgentPrompt(
                    'Codestral Agent: réparation du patch...',
                    buildAgentPatchRepairPrompt(rawPatch),
                    maxTokens
                );
                patch = repairedPatch ? parseAgentPatch(repairedPatch) : undefined;
            }

            if (!patch || patch.changes.length === 0) {
                agentState.status = 'blocked';
                agentState.phase = 'invalid-patch';
                agentState.lastError = 'Patch JSON absent ou sans changements.';
                agentState.updatedAt = Date.now();
                await persistAgentAutonomyState(context, workspaceRoot, agentState);
                await openMarkdownDocument('Codestral Agent Response', rawPatch);
                vscode.window.showWarningMessage('Codestral n’a pas fourni de patch JSON applicable.');
                return;
            }

            try {
                await validateAgentPatch(patch, workspaceRoot);
            } catch (error) {
                const validationError = error instanceof Error ? error.message : String(error);
                await sidebarProvider.postAgentUpdate(`Patch invalide, tentative de réparation: ${validationError}`);
                const repairPrompt = buildAgentPatchValidationRepairPrompt(rawPatch, validationError, workspaceContext);
                const repairedPatch = await runAgentPrompt(
                    'Codestral Agent: réparation du patch invalide...',
                    repairPrompt,
                    maxTokens
                );
                patch = repairedPatch ? parseAgentPatch(repairedPatch) : undefined;
                if (!patch || patch.changes.length === 0) {
                    agentState.status = 'blocked';
                    agentState.phase = 'patch-validation';
                    agentState.lastError = validationError;
                    agentState.updatedAt = Date.now();
                    await persistAgentAutonomyState(context, workspaceRoot, agentState);
                    vscode.window.showWarningMessage(`Patch Codestral invalide: ${validationError}`);
                    return;
                }
                await validateAgentPatch(patch, workspaceRoot);
            }

            await sidebarProvider.postAgentUpdate(formatAgentSidebarUpdate(patch, iteration));
            sidebarProvider.postAgentTimeline(`Codestral Agent ${iteration}/${maxIterations}`, [
                { phase: 'Workspace', status: '✓', detail: 'Contexte collecté' },
                { phase: 'Patch', status: '✓', detail: `${patch.changes.length} fichier(s): ${patch.changes.map(change => change.path).join(', ')}` },
                { phase: 'Diff', status: '●', detail: 'Affichage et préparation application' },
                { phase: 'Validation', status: '○', detail: 'En attente' }
            ]);
            await openMarkdownDocument('Codestral Agent Plan', formatAgentPlan(patch, iteration));
            sidebarProvider.postAgentPlan(`Codestral Agent ${iteration}/${maxIterations}`, [
                { label: 'Lire le workspace', status: '✓' },
                { label: 'Générer le patch', status: '✓' },
                { label: 'Afficher les diffs', status: '●' },
                { label: 'Appliquer les fichiers choisis', status: '○' },
                { label: 'Lancer les tests', status: '○' },
                { label: 'Corriger si nécessaire', status: '○' }
            ]);
            await showAgentDiffs(patch, workspaceRoot, diffProvider);
            agentState.phase = 'diff-review';
            agentState.updatedAt = Date.now();
            await persistAgentAutonomyState(context, workspaceRoot, agentState);

            const reviewPatchByFile = currentConfig.get<boolean>('reviewPatchByFile', false);
            const selectedChanges = reviewPatchByFile ? await selectAgentChanges(patch) : patch.changes;
            if (!selectedChanges) {
                agentState.status = 'stopped';
                agentState.phase = 'patch-rejected';
                agentState.updatedAt = Date.now();
                await persistAgentAutonomyState(context, workspaceRoot, agentState);
                await sidebarProvider.postAgentUpdate('Patch refusé par l’utilisateur.');
                return;
            }

            if (selectedChanges.length === 0) {
                agentState.status = 'stopped';
                agentState.phase = 'no-selected-files';
                agentState.updatedAt = Date.now();
                await persistAgentAutonomyState(context, workspaceRoot, agentState);
                await sidebarProvider.postAgentUpdate('Aucun fichier sélectionné pour application.');
                return;
            }

            const selectedPatch: AgentPatch = {
                ...patch,
                changes: selectedChanges
            };

            if (!shouldAutoApplyAgentPatch(selectedPatch, currentConfig)) {
                const applyChoice = await vscode.window.showWarningMessage(
                    `Appliquer ${selectedPatch.changes.length}/${patch.changes.length} fichier(s) proposés par Codestral ?`,
                    { modal: true },
                    'Appliquer',
                    'Annuler'
                );

                if (applyChoice !== 'Appliquer') {
                    agentState.status = 'stopped';
                    agentState.phase = 'apply-rejected';
                    agentState.updatedAt = Date.now();
                    await persistAgentAutonomyState(context, workspaceRoot, agentState);
                    await sidebarProvider.postAgentUpdate('Patch refusé par l’utilisateur.');
                    return;
                }
            } else {
                await sidebarProvider.postAgentUpdate('Patch sûr détecté: application automatique contrôlée.');
            }

            let backups: AgentBackup[];
            try {
                agentState.phase = 'apply';
                agentState.updatedAt = Date.now();
                await persistAgentAutonomyState(context, workspaceRoot, agentState);
                backups = await applyAgentPatch(selectedPatch, workspaceRoot);
            } catch (error) {
                const conflictError = error instanceof Error ? error.message : String(error);
                await sidebarProvider.postAgentUpdate(`Conflit détecté, tentative de fusion IA: ${conflictError}`);
                const conflictContext = await collectWorkspaceContext(currentTask);
                const conflictSnapshots = await buildAgentConflictSnapshots(selectedPatch, workspaceRoot);
                const repairedPatchRaw = await runAgentPrompt(
                    'Codestral Agent: fusion du conflit...',
                    buildAgentConflictRepairPrompt(selectedPatch, conflictError, conflictContext, conflictSnapshots),
                    maxTokens
                );
                const repairedPatch = repairedPatchRaw ? parseAgentPatch(repairedPatchRaw) : undefined;
                if (!repairedPatch || repairedPatch.changes.length === 0) {
                    agentState.status = 'blocked';
                    agentState.phase = 'conflict-merge';
                    agentState.lastError = conflictError;
                    agentState.updatedAt = Date.now();
                    await persistAgentAutonomyState(context, workspaceRoot, agentState);
                    vscode.window.showWarningMessage(`Conflit non résolu: ${conflictError}`);
                    return;
                }
                await validateAgentPatch(repairedPatch, workspaceRoot);
                await showAgentDiffs(repairedPatch, workspaceRoot, diffProvider);
                backups = await applyAgentPatch(repairedPatch, workspaceRoot);
                selectedPatch.changes = repairedPatch.changes;
                selectedPatch.summary = repairedPatch.summary;
                selectedPatch.plan = repairedPatch.plan;
            }
            sidebarProvider.postAgentPlan(`Codestral Agent ${iteration}/${maxIterations}`, [
                { label: 'Lire le workspace', status: '✓' },
                { label: 'Générer le patch', status: '✓' },
                { label: 'Afficher les diffs', status: '✓' },
                { label: 'Appliquer les fichiers choisis', status: '✓' },
                { label: 'Lancer les tests', status: '●' },
                { label: 'Corriger si nécessaire', status: '○' }
            ]);
            await sidebarProvider.postAgentUpdate(`${selectedPatch.changes.length} changement(s) appliqué(s). Lancement des tests.`);
            sidebarProvider.postAgentTimeline(`Codestral Agent ${iteration}/${maxIterations}`, [
                { phase: 'Workspace', status: '✓', detail: 'Contexte collecté' },
                { phase: 'Patch', status: '✓', detail: `${selectedPatch.changes.length} fichier(s) appliqué(s)` },
                { phase: 'Validation', status: '●', detail: 'Commandes projet en cours' },
                { phase: 'Logs', status: '○', detail: 'En attente' }
            ]);
            lastAgentRun = {
                summary: selectedPatch.summary,
                backups
            };
            await context.globalState.update('lastAgentRun', lastAgentRun);
            const runRecord: AgentRunRecord = {
                id: createAgentRunId(),
                task,
                createdAt: Date.now(),
                summary: selectedPatch.summary,
                backups,
                changes: selectedPatch.changes.map(change => ({
                    path: change.path,
                    action: change.action
                }))
            };
            agentRunHistory = [runRecord, ...agentRunHistory].slice(0, 25);
            await context.globalState.update('agentRunHistory', agentRunHistory);
            await saveProjectMemory(workspaceRoot, agentRunHistory);

            const validationCommands = await determineAgentValidationCommands(selectedPatch, currentConfig, workspaceRoot);
            runRecord.testCommand = validationCommands.map(item => item.command).join(' && ') || undefined;
            agentState.phase = 'validation';
            agentState.lastTestCommand = runRecord.testCommand;
            agentState.updatedAt = Date.now();
            await persistAgentAutonomyState(context, workspaceRoot, agentState);
            if (validationCommands.length === 0) {
                agentState.status = 'success';
                agentState.phase = 'no-validation-configured';
                agentState.updatedAt = Date.now();
                await persistAgentAutonomyState(context, workspaceRoot, agentState);
                await context.globalState.update('agentRunHistory', agentRunHistory);
                await saveProjectMemory(workspaceRoot, agentRunHistory);
                vscode.window.showInformationMessage('Changements appliqués. Aucun test configuré.');
                return;
            }

            const testResult = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Codestral Agent: validation du projet',
                cancellable: false
            }, async () => runValidationCommands(validationCommands, workspaceRoot, outputChannel));

            lastTestOutput = testResult.output;
            runRecord.testExitCode = testResult.exitCode;
            agentState.lastTestExitCode = testResult.exitCode;
            agentState.updatedAt = Date.now();
            await persistAgentAutonomyState(context, workspaceRoot, agentState);
            runRecord.testOutputPreview = testResult.output.slice(0, 4000);
            await writeAgentRunLog(workspaceRoot, runRecord, testResult.output);
            agentRunHistory = agentRunHistory.map(record => record.id === runRecord.id ? runRecord : record);
            await context.globalState.update('agentRunHistory', agentRunHistory);
            await saveProjectMemory(workspaceRoot, agentRunHistory);
            await openMarkdownDocument(
                `Codestral Agent Test Output ${iteration}`,
                [
                    `Commande: \`${runRecord.testCommand}\``,
                    `Code de sortie: ${testResult.exitCode ?? 'inconnu'}`,
                    '',
                    '```',
                    testResult.output,
                    '```'
                ].join('\n')
            );

            if (testResult.exitCode === 0) {
                agentState.status = 'success';
                agentState.phase = 'done';
                agentState.updatedAt = Date.now();
                await persistAgentAutonomyState(context, workspaceRoot, agentState);
                await sidebarProvider.postAgentUpdate('Tests terminés avec succès. Tâche agent terminée.');
                sidebarProvider.postAgentTimeline(`Codestral Agent ${iteration}/${maxIterations}`, [
                    { phase: 'Patch', status: '✓', detail: `${selectedPatch.changes.length} fichier(s) appliqué(s)` },
                    { phase: 'Validation', status: '✓', detail: runRecord.testCommand ?? 'Aucune commande' },
                    { phase: 'Logs', status: '✓', detail: `.codestral/runs/${runRecord.id}.md` },
                    { phase: 'Terminé', status: '✓', detail: 'Succès' }
                ]);
                sidebarProvider.postAgentPlan(`Codestral Agent ${iteration}/${maxIterations}`, [
                    { label: 'Lire le workspace', status: '✓' },
                    { label: 'Générer le patch', status: '✓' },
                    { label: 'Afficher les diffs', status: '✓' },
                    { label: 'Appliquer les fichiers choisis', status: '✓' },
                    { label: 'Lancer les tests', status: '✓' },
                    { label: 'Terminé', status: '✓' }
                ]);
                vscode.window.showInformationMessage('Codestral Agent a appliqué les changements et les tests passent.');
                return;
            }

            if (iteration === maxIterations) {
                agentState.status = 'blocked';
                agentState.phase = 'validation-failed';
                agentState.lastError = 'Tests encore en échec après le dernier cycle agent.';
                agentState.updatedAt = Date.now();
                await persistAgentAutonomyState(context, workspaceRoot, agentState);
                await sidebarProvider.postAgentUpdate('Tests encore en échec après le dernier cycle agent.');
                sidebarProvider.postAgentTimeline(`Codestral Agent ${iteration}/${maxIterations}`, [
                    { phase: 'Patch', status: '✓', detail: `${selectedPatch.changes.length} fichier(s) appliqué(s)` },
                    { phase: 'Validation', status: '✕', detail: runRecord.testCommand ?? 'Validation échouée' },
                    { phase: 'Logs', status: '✓', detail: `.codestral/runs/${runRecord.id}.md` },
                    { phase: 'Bloqué', status: '✕', detail: 'Cycles épuisés' }
                ]);
                sidebarProvider.postAgentPlan(`Codestral Agent ${iteration}/${maxIterations}`, [
                    { label: 'Lire le workspace', status: '✓' },
                    { label: 'Générer le patch', status: '✓' },
                    { label: 'Afficher les diffs', status: '✓' },
                    { label: 'Appliquer les fichiers choisis', status: '✓' },
                    { label: 'Lancer les tests', status: '✕' },
                    { label: 'Erreur après le dernier cycle', status: '✕' }
                ]);
                vscode.window.showWarningMessage('Tests encore en échec après le dernier cycle agent.');
                return;
            }

            const continueChoice = await vscode.window.showWarningMessage(
                'Les tests échouent. Demander à Codestral de corriger à partir de la sortie ?',
                { modal: true },
                'Corriger',
                'Arrêter'
            );

            if (continueChoice !== 'Corriger') {
                agentState.status = 'stopped';
                agentState.phase = 'user-stopped-after-validation';
                agentState.updatedAt = Date.now();
                await persistAgentAutonomyState(context, workspaceRoot, agentState);
                return;
            }

            currentTask = [
                task,
                '',
                'Les tests ont échoué après le patch précédent. Corrige uniquement ce qui est nécessaire.',
                '',
                'Sortie des tests:',
                lastTestOutput.slice(0, 12000)
            ].join('\n');
        }
    });

    const revertLastAgentPatchCommand = vscode.commands.registerCommand('codestral-ai.revertLastAgentPatch', async () => {
        const workspaceRoot = getWorkspaceRoot();
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('Aucun workspace ouvert.');
            return;
        }

        const revertCandidates = agentRunHistory.filter(record => record.backups.length > 0);
        if (revertCandidates.length === 0 && (!lastAgentRun || lastAgentRun.backups.length === 0)) {
            vscode.window.showInformationMessage('Aucun patch agent à annuler dans cette session.');
            return;
        }

        const selectedRun = revertCandidates.length > 0
            ? await vscode.window.showQuickPick(
                revertCandidates.map(record => ({
                    label: record.summary,
                    description: new Date(record.createdAt).toLocaleString(),
                    detail: `${record.changes.length} fichier(s): ${record.changes.map(change => change.path).join(', ')}`,
                    record
                })),
                {
                    title: 'Codestral: annuler un patch agent',
                    placeHolder: 'Choisis le patch à annuler'
                }
            )
            : undefined;

        const runToRevert = selectedRun?.record ?? (lastAgentRun ? {
            id: 'legacy',
            task: '',
            createdAt: Date.now(),
            summary: lastAgentRun.summary,
            backups: lastAgentRun.backups,
            changes: []
        } satisfies AgentRunRecord : undefined);

        if (!runToRevert) {
            return;
        }

        const choice = await vscode.window.showWarningMessage(
            `Annuler le patch agent: ${runToRevert.summary} ?`,
            { modal: true },
            'Annuler le patch'
        );

        if (choice !== 'Annuler le patch') {
            return;
        }

        await revertAgentPatch(runToRevert.backups, workspaceRoot);
        agentRunHistory = agentRunHistory.filter(record => record.id !== runToRevert.id);
        await context.globalState.update('agentRunHistory', agentRunHistory);
        await saveProjectMemory(workspaceRoot, agentRunHistory);
        vscode.window.showInformationMessage('Patch agent annulé.');
        lastAgentRun = undefined;
        await context.globalState.update('lastAgentRun', undefined);
    });

    const planTaskCommand = vscode.commands.registerCommand('codestral-ai.planTask', async () => {
        const task = await vscode.window.showInputBox({
            prompt: 'Décris la tâche à planifier',
            placeHolder: 'Ex: Ajouter une authentification, corriger un bug, refactorer ce module...'
        });

        if (!task) {
            return;
        }

        const workspaceContext = await collectWorkspaceContext(task);
        const response = await runAgentPrompt(
            'Codestral: plan de tâche...',
            [
                'Tu es un agent de code. Prépare un plan de travail concret pour cette tâche.',
                'Identifie les fichiers probables, les risques, les étapes et les vérifications à lancer.',
                'Ne modifie rien. Réponds en français avec une checklist actionnable.',
                '',
                `Tâche: ${task}`,
                '',
                workspaceContext
            ].join('\n')
        );

        if (response) {
            await openMarkdownDocument('Codestral Plan', response);
        }
    });

    const reviewWorkspaceCommand = vscode.commands.registerCommand('codestral-ai.reviewWorkspace', async () => {
        const workspaceContext = await collectWorkspaceContext('review workspace');
        const response = await runAgentPrompt(
            'Codestral: revue du workspace...',
            [
                'Fais une revue de ce workspace comme un agent de code.',
                'Priorise architecture, bugs probables, dette technique, sécurité, tests manquants et prochaines étapes.',
                'Réponds en français avec des points courts et actionnables.',
                '',
                workspaceContext
            ].join('\n')
        );

        if (response) {
            await openMarkdownDocument('Codestral Workspace Review', response);
        }
    });

    const runTestsCommand = vscode.commands.registerCommand('codestral-ai.runTests', async () => {
        const currentConfig = vscode.workspace.getConfiguration('codestral-ai');
        const defaultCommand = currentConfig.get<string>('testCommand', 'npm test');
        const command = await vscode.window.showInputBox({
            prompt: 'Commande de test à lancer',
            value: defaultCommand
        });

        if (!command) {
            return;
        }

        const workspaceRoot = getWorkspaceRoot();
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('Aucun workspace ouvert.');
            return;
        }

        const output = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Codestral: lancement de ${command}`,
            cancellable: false
        }, async () => runShellCommand(command, workspaceRoot, outputChannel));

        await openMarkdownDocument(
            'Codestral Test Output',
            [
                `Commande: \`${command}\``,
                '',
                '```',
                output,
                '```'
            ].join('\n')
        );

        const currentApiKey = await ensureApiKey();
        if (!currentApiKey) {
            return;
        }

        const workspaceContext = await collectWorkspaceContext(command);
        const diagnosis = await runAgentPrompt(
            'Codestral: diagnostic des tests...',
            [
                'Analyse cette sortie de tests comme un agent de code.',
                'Explique la cause probable, les fichiers à inspecter et les corrections recommandées.',
                'Si les tests passent, propose les prochaines vérifications utiles.',
                '',
                workspaceContext,
                '',
                `Commande: ${command}`,
                'Sortie:',
                '```',
                output.slice(0, 12000),
                '```'
            ].join('\n')
        );

        if (diagnosis) {
            await openMarkdownDocument('Codestral Test Diagnosis', diagnosis);
        }
    });

    // Ajouter les commandes au contexte
    context.subscriptions.push(setApiKeyCommand);
    context.subscriptions.push(selectModelCommand);
    context.subscriptions.push(showAvailableModelsCommand);
    context.subscriptions.push(openSettingsMenuCommand);
    context.subscriptions.push(rebuildWorkspaceIndexCommand);
    context.subscriptions.push(stopAgentCommand);
    context.subscriptions.push(rerunAgentCommand);
    context.subscriptions.push(startDevServerCommand);
    context.subscriptions.push(stopDevServerCommand);
    context.subscriptions.push(restartDevServerCommand);
    context.subscriptions.push(completeCodeCommand);
    context.subscriptions.push(chatCommand);
    context.subscriptions.push(explainSelectionCommand);
    context.subscriptions.push(fixSelectionCommand);
    context.subscriptions.push(generateTestsCommand);
    context.subscriptions.push(reviewFileCommand);
    context.subscriptions.push(agentTaskCommand);
    context.subscriptions.push(revertLastAgentPatchCommand);
    context.subscriptions.push(planTaskCommand);
    context.subscriptions.push(reviewWorkspaceCommand);
    context.subscriptions.push(runTestsCommand);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            CodestralSidebarProvider.viewType,
            sidebarProvider
        )
    );

    // Ajouter un fournisseur de complétion pour l'autocomplétion inline
    const completionProvider = vscode.languages.registerCompletionItemProvider(
        '*',
        {
            provideCompletionItems: async (document, position) => {
                if (!apiKey) {
                    return [];
                }

                const line = document.lineAt(position.line);
                const textBeforeCursor = line.text.substring(0, position.character);

                if (textBeforeCursor.trim().length === 0) {
                    return [];
                }

                try {
                    const maxTokens = Math.min(config.get<number>('maxTokens', 100), 100);
                    const model = config.get<string>('model', 'codestral-latest');
                    const completion = await callCodestralCompletion(
                        apiKey,
                        textBeforeCursor,
                        maxTokens,
                        0.5,
                        model
                    );

                    if (completion) {
                        const completionItem = new vscode.CompletionItem({
                            label: '$(lightbulb) Codestral',
                            description: completion
                        });
                        completionItem.insertText = new vscode.SnippetString(completion);
                        completionItem.documentation = new vscode.MarkdownString('Suggestion par Codestral AI');
                        completionItem.sortText = 'a'; // Priorité élevée
                        return [completionItem];
                    }
                } catch (error) {
                    console.error('Erreur de complétion Codestral:', error);
                }

                return [];
            }
        },
        '.'
    );

    context.subscriptions.push(completionProvider);
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }

    return text;
}

function getActiveEditorContext(): string {
    const editor = vscode.window.activeTextEditor ?? lastActiveTextEditor;
    if (!editor) {
        return '';
    }

    const document = editor.document;
    const selection = editor.selection;
    const selectedText = selection.isEmpty ? '' : document.getText(selection);
    const text = selectedText || document.getText();
    const trimmedText = text.length > 6000 ? text.slice(0, 6000) : text;

    return [
        `Fichier: ${document.fileName}`,
        `Langage: ${document.languageId}`,
        selectedText ? 'Selection active:' : 'Contexte du fichier actif:',
        trimmedText
    ].join('\n');
}

function getActiveCodeInput(requireSelection: boolean): ActiveCodeInput | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('Aucun éditeur actif trouvé.');
        return undefined;
    }

    const document = editor.document;
    const selection = editor.selection;

    if (requireSelection && selection.isEmpty) {
        vscode.window.showErrorMessage('Sélectionne du code avant de lancer cette action.');
        return undefined;
    }

    const lastLine = document.lineAt(document.lineCount - 1);
    const wholeDocumentRange = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(document.lineCount - 1, lastLine.text.length)
    );
    const range = selection.isEmpty ? wholeDocumentRange : selection;
    const text = document.getText(range);

    if (!text.trim()) {
        vscode.window.showErrorMessage('Aucun code à envoyer à Codestral.');
        return undefined;
    }

    return {
        editor,
        document,
        range,
        text,
        isSelection: !selection.isEmpty
    };
}

function buildCodeContext(input: ActiveCodeInput): string {
    const text = input.text.length > 12000 ? input.text.slice(0, 12000) : input.text;

    return [
        `Fichier: ${input.document.fileName}`,
        `Langage: ${input.document.languageId}`,
        input.isSelection ? 'Code sélectionné:' : 'Fichier actif:',
        '```',
        text,
        '```'
    ].join('\n');
}

function extractCodeFromResponse(response: string): string {
    const fencedBlock = response.match(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/);
    if (fencedBlock) {
        return fencedBlock[1].trim();
    }

    return response.trim();
}

function buildAgentPatchPrompt(task: string, workspaceContext: string, testOutput: string): string {
    return [
        'Tu es Codestral Agent, un agent de code autonome dans VSCodium.',
        'Tu dois produire un patch multi-fichiers directement applicable.',
        'Tu peux créer, modifier et supprimer des fichiers dans le workspace ouvert.',
        'Utilise l’arborescence, l’index local, les cibles explicites et les extraits de contenu pour choisir les bons fichiers sans demander un bouton supplémentaire.',
        'Si la demande vise tout le projet, raisonne à partir de l’index et applique une correction cohérente multi-fichiers.',
        'Utilise le profil environnement pour choisir les conventions du projet, le package manager, les scripts, le serveur dev et les validations adaptées.',
        'Pour les gros projets, utilise les packs de contexte pour repérer les dossiers clés avant de modifier les extraits détaillés.',
        'Après une erreur de test, lis la sortie, corrige la cause racine, puis produis un patch minimal de réparation.',
        'Pour un projet web, pense aux références HTML/CSS/JS et évite de casser les chemins de ressources.',
        'N’écris pas de commande destructive dans testCommand: pas de rm -rf, git reset --hard, git clean -fd, chmod 777 ou sudo rm.',
        'Réponds uniquement avec un objet JSON valide, sans Markdown, sans texte autour.',
        '',
        'Schéma JSON obligatoire:',
        '{',
        '  "summary": "résumé court",',
        '  "plan": ["étape 1", "étape 2"],',
        '  "changes": [',
        '    { "path": "chemin/relatif.ext", "action": "create|modify|delete", "content": "contenu complet du fichier pour create/modify", "unifiedDiff": "diff unifié optionnel pour modify" }',
        '  ],',
        '  "testCommand": "commande optionnelle à lancer",',
        '  "notes": ["note optionnelle"]',
        '}',
        '',
        'Règles:',
        '- paths doivent être relatifs au workspace.',
        '- Pour create, content doit être le contenu complet final du fichier.',
        '- Pour modify, préfère unifiedDiff si le changement est petit; sinon fournis content complet.',
        '- Pour delete, ne fournis pas content.',
        '- Ne modifie que les fichiers nécessaires.',
        '- Si tu n’as pas assez de contexte, fais le plus petit patch raisonnable.',
        '',
        `Tâche utilisateur:\n${task}`,
        '',
        testOutput ? `Sortie de tests précédente:\n${testOutput.slice(0, 12000)}` : '',
        '',
        workspaceContext
    ].filter(Boolean).join('\n');
}

function buildAgentPatchRepairPrompt(rawPatch: string): string {
    return [
        'Convertis cette réponse en objet JSON valide qui respecte exactement ce schéma.',
        'Réponds uniquement avec le JSON corrigé, sans Markdown.',
        '',
        '{',
        '  "summary": "résumé court",',
        '  "plan": ["étape 1"],',
        '  "changes": [',
        '    { "path": "chemin/relatif.ext", "action": "create|modify|delete", "content": "contenu complet du fichier", "unifiedDiff": "diff unifié optionnel" }',
        '  ],',
        '  "testCommand": "commande optionnelle",',
        '  "notes": ["note optionnelle"]',
        '}',
        '',
        'Réponse à réparer:',
        rawPatch
    ].join('\n');
}

function buildAgentPatchValidationRepairPrompt(rawPatch: string, validationError: string, workspaceContext: string): string {
    return [
        'Le patch JSON suivant est invalide ou impossible à appliquer.',
        'Répare-le pour produire un patch applicable au workspace actuel.',
        'Réponds uniquement avec un objet JSON valide, sans Markdown.',
        '',
        'Si un unifiedDiff est fragile, remplace-le par le contenu complet final du fichier.',
        'Ne change pas la demande fonctionnelle. Ne modifie que les fichiers nécessaires.',
        '',
        `Erreur de validation:\n${validationError}`,
        '',
        'Patch original:',
        rawPatch,
        '',
        'Contexte workspace:',
        workspaceContext.slice(0, 18000)
    ].join('\n');
}

function buildAgentConflictRepairPrompt(
    patch: AgentPatch,
    conflictError: string,
    workspaceContext: string,
    conflictSnapshots: string
): string {
    return [
        'Un patch agent ne peut pas être appliqué car le fichier actuel a changé.',
        'Fusionne la version actuelle du workspace avec l’intention du patch.',
        'Réponds uniquement avec un objet JSON valide applicable, sans Markdown.',
        '',
        'Règles:',
        '- Préserve les changements déjà présents dans le fichier actuel.',
        '- Applique seulement l’intention du patch original.',
        '- Si un diff est risqué, fournis le contenu complet final du fichier.',
        '- Ne supprime aucun contenu utilisateur non lié à la tâche.',
        '- Utilise les snapshots précis ci-dessous comme source principale, puis le contexte workspace comme aide.',
        '- Si le patch original et le fichier actuel modifient la même zone, produis une fusion explicite et minimale.',
        '',
        `Erreur:\n${conflictError}`,
        '',
        'Snapshots conflit:',
        conflictSnapshots,
        '',
        'Patch original:',
        JSON.stringify(patch, null, 2),
        '',
        'Contexte workspace actuel:',
        workspaceContext.slice(0, 20000)
    ].join('\n');
}

function parseAgentPatch(raw: string): AgentPatch | undefined {
    const trimmed = raw.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1].trim() : trimmed;
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    const jsonText = firstBrace >= 0 && lastBrace > firstBrace
        ? candidate.slice(firstBrace, lastBrace + 1)
        : candidate;

    try {
        const parsed = JSON.parse(jsonText) as AgentPatch;
        if (!parsed || !Array.isArray(parsed.changes)) {
            return undefined;
        }

        return {
            summary: String(parsed.summary || 'Patch Codestral'),
            plan: Array.isArray(parsed.plan) ? parsed.plan.map(String) : [],
            changes: parsed.changes
                .filter(change => typeof change?.path === 'string' && typeof change?.action === 'string')
                .map(change => ({
                    path: change.path,
                    action: change.action,
                    content: typeof change.content === 'string' ? change.content : undefined,
                    unifiedDiff: typeof change.unifiedDiff === 'string' ? change.unifiedDiff : undefined
                }))
                .filter(change => ['create', 'modify', 'delete'].includes(change.action)),
            testCommand: typeof parsed.testCommand === 'string' ? parsed.testCommand : undefined,
            notes: Array.isArray(parsed.notes) ? parsed.notes.map(String) : []
        };
    } catch {
        return undefined;
    }
}

async function buildAgentConflictSnapshots(patch: AgentPatch, workspaceRoot: string): Promise<string> {
    const sections: string[] = [];
    for (const change of patch.changes.slice(0, 12)) {
        const targetUri = resolveWorkspaceFile(workspaceRoot, change.path);
        const currentContent = await readFileIfExists(targetUri);
        let proposedContent = '';
        try {
            proposedContent = change.action === 'delete'
                ? ''
                : getProposedContent(currentContent, change);
        } catch {
            proposedContent = change.content ?? '';
        }

        sections.push([
            `--- ${change.path} ---`,
            `Action: ${change.action}`,
            `Base hash attendu: ${change.baseContentHash ?? 'inconnu'}`,
            '',
            'Version actuelle du fichier:',
            '```',
            currentContent.slice(0, 12000),
            '```',
            '',
            change.unifiedDiff ? 'Diff original:' : '',
            change.unifiedDiff ? '```diff' : '',
            change.unifiedDiff ? change.unifiedDiff.slice(0, 8000) : '',
            change.unifiedDiff ? '```' : '',
            '',
            proposedContent ? 'Résultat proposé en appliquant l’intention au fichier actuel:' : '',
            proposedContent ? '```' : '',
            proposedContent ? proposedContent.slice(0, 12000) : '',
            proposedContent ? '```' : ''
        ].filter(line => line !== '').join('\n'));
    }

    return sections.join('\n\n');
}

function createAgentRunId(): string {
    return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function validateAgentPatch(patch: AgentPatch, workspaceRoot: string): Promise<void> {
    for (const change of patch.changes) {
        const targetUri = resolveWorkspaceFile(workspaceRoot, change.path);
        if (change.action === 'create' && typeof change.content !== 'string') {
            throw new Error(`${change.path}: contenu manquant pour create`);
        }

        if (change.action === 'modify') {
            if (typeof change.content !== 'string' && typeof change.unifiedDiff !== 'string') {
                throw new Error(`${change.path}: content ou unifiedDiff requis pour modify`);
            }

            if (change.unifiedDiff && typeof change.content !== 'string') {
                const originalContent = await readFileIfExists(targetUri);
                applyUnifiedDiff(originalContent, change.unifiedDiff);
            }
        }
    }
}

function shouldAutoApplyAgentPatch(patch: AgentPatch, config: vscode.WorkspaceConfiguration): boolean {
    if (!config.get<boolean>('autoApplySafePatches', true)) {
        return false;
    }

    if (patch.changes.some(change => change.action === 'delete')) {
        return false;
    }

    if (patch.changes.length > 8) {
        return false;
    }

    return patch.changes.every(change => (change.content?.length ?? 0) < 80000);
}

async function determineAgentValidationCommands(
    patch: AgentPatch,
    config: vscode.WorkspaceConfiguration,
    workspaceRoot: string
): Promise<ValidationCommand[]> {
    if (patch.testCommand && patch.testCommand.trim()) {
        return [{ label: 'model-test', command: patch.testCommand.trim() }];
    }

    const configured = config.get<string>('testCommand', 'npm test').trim();
    if (configured && configured !== 'npm test') {
        return [{ label: 'configured-test', command: configured }];
    }

    return detectProjectValidationCommands(workspaceRoot, patch);
}

async function detectProjectValidationCommands(workspaceRoot: string, patch: AgentPatch): Promise<ValidationCommand[]> {
    const commands: ValidationCommand[] = [];
    const packageJson = await readJsonIfExists(vscode.Uri.file(path.join(workspaceRoot, 'package.json')));
    if (packageJson && typeof packageJson === 'object') {
        const packageRecord = packageJson as Record<string, unknown> & { scripts?: Record<string, string> };
        const scripts = packageRecord.scripts ?? {};
        const packageManager = await detectPackageManager(workspaceRoot);
        const run = packageManager.run;
        const install = packageManager.install;
        const lockExists = packageManager.lockFile
            ? await fileExists(path.join(workspaceRoot, packageManager.lockFile))
            : true;
        const hasDependencies = packageJsonHasDependencies(packageRecord);
        const touchedOnlyStaticWebAssets = patch.changes.length > 0
            && patch.changes.every(change => /\.(html?|css|js|mjs|cjs)$/i.test(change.path));

        if (!lockExists && hasDependencies && await fileExists(path.join(workspaceRoot, 'package.json'))) {
            commands.push({ label: 'install', command: install });
        }
        if (hasMeaningfulPackageScript(scripts.lint)) {
            commands.push({ label: 'lint', command: `${run} lint` });
        }
        if (hasMeaningfulPackageScript(scripts.typecheck)) {
            commands.push({ label: 'typecheck', command: `${run} typecheck` });
        } else if (hasMeaningfulPackageScript(scripts.check)) {
            commands.push({ label: 'check', command: `${run} check` });
        }
        if (hasMeaningfulPackageScript(scripts.build)) {
            commands.push({ label: 'build', command: `${run} build` });
        }
        if (hasMeaningfulPackageScript(scripts.test)) {
            commands.push({ label: 'test', command: packageManager.test });
        }
        if (hasMeaningfulPackageScript(scripts['test:e2e'])) {
            commands.push({ label: 'e2e', command: `${run} test:e2e` });
        } else if (hasMeaningfulPackageScript(scripts.e2e)) {
            commands.push({ label: 'e2e', command: `${run} e2e` });
        }
        if (!hasDependencies && touchedOnlyStaticWebAssets) {
            addJavascriptSyntaxValidation(commands, patch);
        }
        addStaticSmokeIfUseful(commands, patch);
        return commands;
    }

    if (await fileExists(path.join(workspaceRoot, 'Cargo.toml'))) {
        return [
            { label: 'build', command: 'cargo check' },
            { label: 'test', command: 'cargo test' }
        ];
    }

    if (await fileExists(path.join(workspaceRoot, 'go.mod'))) {
        return [
            { label: 'test', command: 'go test ./...' }
        ];
    }

    const hasPythonProject = await fileExists(path.join(workspaceRoot, 'pyproject.toml'))
        || await fileExists(path.join(workspaceRoot, 'requirements.txt'));
    const hasPythonTests = (await vscode.workspace.findFiles('**/{test_*.py,*_test.py}', '**/{.git,node_modules,out,dist,build,coverage}/**', 1)).length > 0;
    if (hasPythonProject && hasPythonTests) {
        return [{ label: 'test', command: 'python -m pytest' }];
    }

    addJavascriptSyntaxValidation(commands, patch);
    addStaticSmokeIfUseful(commands, patch);
    return commands;
}

function packageJsonHasDependencies(packageJson: Record<string, unknown>): boolean {
    return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
        .some(key => {
            const value = packageJson[key];
            return !!value && typeof value === 'object' && Object.keys(value as Record<string, unknown>).length > 0;
        });
}

function hasMeaningfulPackageScript(script: unknown): script is string {
    if (typeof script !== 'string') {
        return false;
    }
    const normalized = script.trim().toLowerCase();
    if (!normalized) {
        return false;
    }
    return ![
        /^echo\b/,
        /\bopen\s+index\.html\b/,
        /\bstart\s+index\.html\b/,
        /ouvrez?\s+index\.html/,
        /ouvrir\s+index\.html/,
        /navigateur/
    ].some(pattern => pattern.test(normalized));
}

function addJavascriptSyntaxValidation(commands: ValidationCommand[], patch: AgentPatch): void {
    const jsFiles = patch.changes
        .filter(change => change.action !== 'delete' && /\.(js|mjs|cjs)$/i.test(change.path))
        .map(change => shellQuote(change.path))
        .slice(0, 8);
    if (jsFiles.length > 0) {
        commands.push({ label: 'syntax', command: jsFiles.map(file => `node --check ${file}`).join(' && ') });
    }
}

async function detectPackageManager(workspaceRoot: string): Promise<{
    name: string;
    run: string;
    install: string;
    test: string;
    lockFile?: string;
}> {
    if (await fileExists(path.join(workspaceRoot, 'pnpm-lock.yaml'))) {
        return { name: 'pnpm', run: 'pnpm run', install: 'pnpm install', test: 'pnpm test', lockFile: 'pnpm-lock.yaml' };
    }
    if (await fileExists(path.join(workspaceRoot, 'yarn.lock'))) {
        return { name: 'yarn', run: 'yarn', install: 'yarn install', test: 'yarn test', lockFile: 'yarn.lock' };
    }
    if (await fileExists(path.join(workspaceRoot, 'bun.lockb')) || await fileExists(path.join(workspaceRoot, 'bun.lock'))) {
        return { name: 'bun', run: 'bun run', install: 'bun install', test: 'bun test', lockFile: 'bun.lockb' };
    }
    return { name: 'npm', run: 'npm run', install: 'npm install', test: 'npm test', lockFile: 'package-lock.json' };
}

function addStaticSmokeIfUseful(commands: ValidationCommand[], patch: AgentPatch): void {
    const htmlFiles = patch.changes
        .filter(change => change.action !== 'delete' && /\.html?$/i.test(change.path))
        .map(change => change.path);
    const touchedWebAsset = patch.changes.some(change => /\.(html?|css|js|mjs|cjs|ts|tsx|jsx)$/i.test(change.path));

    if (htmlFiles.length > 0 || touchedWebAsset) {
        commands.push({
            label: 'static-smoke',
            command: 'Codestral static HTML asset smoke check',
            kind: 'static-smoke',
            files: htmlFiles
        });
    }
}

async function readJsonIfExists(uri: vscode.Uri): Promise<unknown | undefined> {
    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch {
        return undefined;
    }
}

async function readProjectMemory(workspaceRoot: string): Promise<ProjectMemory | undefined> {
    const memory = await readJsonIfExists(vscode.Uri.file(path.join(workspaceRoot, '.codestral', 'memory.json')));
    if (!memory || typeof memory !== 'object') {
        return undefined;
    }

    return memory as ProjectMemory;
}

function formatProjectMemoryForPrompt(memory: ProjectMemory): string {
    const runs = (memory.recentAgentRuns ?? [])
        .slice(0, 8)
        .map(run => [
            `- ${new Date(run.createdAt).toISOString()}: ${run.summary}`,
            `  Tâche: ${run.task}`,
            `  Fichiers: ${run.changes.map(change => `${change.action}:${change.path}`).join(', ')}`,
            run.testCommand ? `  Test: ${run.testCommand} -> ${run.testExitCode ?? 'inconnu'}` : ''
        ].filter(Boolean).join('\n'))
        .join('\n');
    const directories = (memory.directories ?? [])
        .slice(0, 20)
        .map(directory => `- ${directory.path}: ${directory.files} fichier(s), ${directory.languages.join(', ')}`)
        .join('\n');

    return [
        `Type projet: ${memory.projectType || 'unknown'}`,
        `Dernière mise à jour: ${memory.updatedAt ? new Date(memory.updatedAt).toISOString() : 'inconnue'}`,
        memory.environment ? 'Environnement:' : '',
        memory.environment ? formatProjectEnvironmentProfile(memory.environment) : '',
        memory.lastAgentState ? 'Dernier état agent:' : '',
        memory.lastAgentState ? formatAgentAutonomyState(memory.lastAgentState) : '',
        directories ? 'Dossiers principaux:' : '',
        directories,
        runs ? 'Runs agent récents:' : '',
        runs
    ].filter(Boolean).join('\n');
}

function formatAgentAutonomyState(state: AgentAutonomyState): string {
    return [
        `Run: ${state.id}`,
        `Statut: ${state.status}`,
        `Phase: ${state.phase}`,
        `Cycle: ${state.iteration}/${state.maxIterations}`,
        `Tâche: ${state.task}`,
        state.lastTestCommand ? `Validation: ${state.lastTestCommand} -> ${state.lastTestExitCode ?? 'inconnu'}` : '',
        state.lastError ? `Erreur: ${state.lastError}` : ''
    ].filter(Boolean).join('\n');
}

async function persistAgentAutonomyState(
    context: vscode.ExtensionContext,
    workspaceRoot: string,
    state: AgentAutonomyState
): Promise<void> {
    await context.globalState.update('activeAgentState', state);
    try {
        const stateDir = vscode.Uri.file(path.join(workspaceRoot, '.codestral'));
        await vscode.workspace.fs.createDirectory(stateDir);
        await vscode.workspace.fs.writeFile(
            vscode.Uri.file(path.join(workspaceRoot, '.codestral', 'agent-state.json')),
            Buffer.from(JSON.stringify(state, null, 2), 'utf8')
        );
    } catch {
        // Agent state persistence must never block code changes.
    }
}

function summarizeWorkspaceDirectories(entries: WorkspaceIndexEntry[]): ProjectMemory['directories'] {
    const directories = new Map<string, { files: number; languages: Set<string> }>();
    for (const entry of entries) {
        const parts = entry.path.split(/[\\/]/);
        const directory = parts.length > 1 ? parts[0] : '.';
        const current = directories.get(directory) ?? { files: 0, languages: new Set<string>() };
        current.files++;
        current.languages.add(entry.language);
        directories.set(directory, current);
    }

    return Array.from(directories.entries())
        .map(([dirPath, value]) => ({
            path: dirPath,
            files: value.files,
            languages: Array.from(value.languages).sort()
        }))
        .sort((a, b) => b.files - a.files)
        .slice(0, 50);
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
        return true;
    } catch {
        return false;
    }
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function saveProjectMemory(workspaceRoot: string, agentRunHistory: AgentRunRecord[]): Promise<void> {
    try {
        const memoryDir = vscode.Uri.file(path.join(workspaceRoot, '.codestral'));
        await vscode.workspace.fs.createDirectory(memoryDir);
        if (workspaceIndexCache.length === 0) {
            workspaceIndexCache = await buildWorkspaceIndex();
        }
        const lastAgentState = extensionContextRef?.globalState.get<AgentAutonomyState>('activeAgentState');

        const memory: ProjectMemory = {
            version: 1,
            updatedAt: Date.now(),
            workspace: workspaceRoot,
            projectType: await detectProjectType(workspaceRoot),
            recentAgentRuns: agentRunHistory.slice(0, 20).map(record => ({
                id: record.id,
                task: record.task,
                summary: record.summary,
                createdAt: record.createdAt,
                changes: record.changes,
                testCommand: record.testCommand,
                testExitCode: record.testExitCode
            })),
            lastAgentState,
            directories: summarizeWorkspaceDirectories(workspaceIndexCache),
            environment: await buildProjectEnvironmentProfile(workspaceRoot),
            workspaceIndex: workspaceIndexCache.slice(0, 300)
        };

        await vscode.workspace.fs.writeFile(
            vscode.Uri.file(path.join(workspaceRoot, '.codestral', 'memory.json')),
            Buffer.from(JSON.stringify(memory, null, 2), 'utf8')
        );
    } catch {
        // Memory must never block code changes.
    }
}

async function writeAgentRunLog(workspaceRoot: string, run: AgentRunRecord, output: string): Promise<void> {
    try {
        const runsDir = vscode.Uri.file(path.join(workspaceRoot, '.codestral', 'runs'));
        await vscode.workspace.fs.createDirectory(runsDir);
        const log = [
            `# ${run.summary}`,
            '',
            `Run: ${run.id}`,
            `Date: ${new Date(run.createdAt).toISOString()}`,
            `Task: ${run.task}`,
            `Test: ${run.testCommand ?? 'none'}`,
            `Exit: ${run.testExitCode ?? 'unknown'}`,
            '',
            '## Changes',
            ...run.changes.map(change => `- ${change.action}: ${change.path}`),
            '',
            '## Output',
            '```',
            output,
            '```'
        ].join('\n');

        await vscode.workspace.fs.writeFile(
            vscode.Uri.file(path.join(workspaceRoot, '.codestral', 'runs', `${run.id}.md`)),
            Buffer.from(log, 'utf8')
        );
    } catch {
        // Logs should not block the agent loop.
    }
}

async function detectProjectType(workspaceRoot: string): Promise<string> {
    if (await fileExists(path.join(workspaceRoot, 'package.json'))) {
        return 'node';
    }
    if (await fileExists(path.join(workspaceRoot, 'pyproject.toml')) || await fileExists(path.join(workspaceRoot, 'requirements.txt'))) {
        return 'python';
    }
    if (await fileExists(path.join(workspaceRoot, 'Cargo.toml'))) {
        return 'rust';
    }
    if (await fileExists(path.join(workspaceRoot, 'go.mod'))) {
        return 'go';
    }
    if ((await vscode.workspace.findFiles('**/*.html', '**/{.git,node_modules,out,dist,build,coverage}/**', 1)).length > 0) {
        return 'static-web';
    }
    return 'unknown';
}

async function buildProjectEnvironmentProfile(workspaceRoot: string): Promise<ProjectEnvironmentProfile> {
    const type = await detectProjectType(workspaceRoot);
    const notes: string[] = [];
    let packageManager: string | undefined;
    let scripts: string[] = [];
    let validation: string[] = [];
    let devServer: string | undefined;

    const packageJson = await readJsonIfExists(vscode.Uri.file(path.join(workspaceRoot, 'package.json')));
    if (packageJson && typeof packageJson === 'object') {
        const manager = await detectPackageManager(workspaceRoot);
        packageManager = manager.name;
        const rawScripts = (packageJson as { scripts?: Record<string, unknown> }).scripts ?? {};
        scripts = Object.keys(rawScripts).sort();
        validation = scripts.filter(script => /^(lint|typecheck|check|build|test|test:e2e|e2e)$/i.test(script));
        devServer = await detectDevServerCommand(workspaceRoot);
        if (!scripts.includes('test')) {
            notes.push('Aucun script test détecté dans package.json.');
        }
        if (!scripts.includes('build')) {
            notes.push('Aucun script build détecté dans package.json.');
        }
    }

    if (type === 'python') {
        validation = [
            await fileExists(path.join(workspaceRoot, 'requirements.txt')) ? 'python dependencies: requirements.txt' : '',
            await fileExists(path.join(workspaceRoot, 'pyproject.toml')) ? 'python project: pyproject.toml' : '',
            'pytest si tests présents'
        ].filter(Boolean);
        if (await fileExists(path.join(workspaceRoot, 'manage.py'))) {
            devServer = 'python manage.py runserver';
        }
    }

    if (type === 'static-web') {
        devServer = 'python -m http.server 5173';
        validation.push('static HTML asset smoke check');
    }

    return {
        type,
        packageManager,
        scripts,
        validation,
        devServer,
        notes
    };
}

function formatProjectEnvironmentProfile(profile: ProjectEnvironmentProfile): string {
    return [
        `Type: ${profile.type}`,
        profile.packageManager ? `Package manager: ${profile.packageManager}` : '',
        profile.scripts.length > 0 ? `Scripts: ${profile.scripts.join(', ')}` : '',
        profile.validation.length > 0 ? `Validation probable: ${profile.validation.join(', ')}` : '',
        profile.devServer ? `Serveur dev probable: ${profile.devServer}` : '',
        profile.notes.length > 0 ? `Notes: ${profile.notes.join(' ')}` : ''
    ].filter(Boolean).join('\n');
}

function formatAgentPlan(patch: AgentPatch, iteration: number): string {
    const changes = patch.changes
        .map(change => `- ${change.action}: \`${change.path}\``)
        .join('\n');
    const plan = patch.plan.map(item => `- ${item}`).join('\n') || '- Aucun plan détaillé fourni.';
    const notes = patch.notes?.map(item => `- ${item}`).join('\n') || '- Aucune note.';

    return [
        `Cycle: ${iteration}`,
        '',
        patch.summary,
        '',
        '### Plan',
        plan,
        '',
        '### Changements',
        changes,
        '',
        '### Tests',
        patch.testCommand ? `\`${patch.testCommand}\`` : 'Commande par défaut configurée.',
        '',
        '### Notes',
        notes
    ].join('\n');
}

function formatAgentSidebarUpdate(patch: AgentPatch, iteration: number): string {
    const plan = patch.plan.map(item => `- ${item}`).join('\n') || '- Plan non détaillé.';
    const changes = patch.changes
        .map(change => `- ${change.action}: ${change.path}`)
        .join('\n');

    return [
        `Plan agent, cycle ${iteration}`,
        '',
        patch.summary,
        '',
        'En cours:',
        plan,
        '',
        'Fichiers:',
        changes
    ].join('\n');
}

async function showAgentDiffs(
    patch: AgentPatch,
    workspaceRoot: string,
    provider: AgentDiffContentProvider
): Promise<void> {
    for (const change of patch.changes) {
        const targetUri = resolveWorkspaceFile(workspaceRoot, change.path);
        const proposedUri = vscode.Uri.parse(
            `codestral-agent:/${encodeURIComponent(change.path)}?${Date.now()}`
        );
        const originalUri = vscode.Uri.parse(
            `codestral-agent:/original-${encodeURIComponent(change.path)}?${Date.now()}`
        );

        const originalContent = change.action === 'create'
            ? ''
            : await readFileIfExists(targetUri);
        change.baseContentHash = hashContent(originalContent);
        const proposedContent = change.action === 'delete'
            ? ''
            : getProposedContent(originalContent, change);

        provider.set(originalUri, originalContent);
        provider.set(proposedUri, proposedContent);

        await vscode.commands.executeCommand(
            'vscode.diff',
            originalUri,
            proposedUri,
            `Codestral Agent: ${change.path}`
        );
    }
}

async function selectAgentChanges(patch: AgentPatch): Promise<AgentChange[] | undefined> {
    const items = patch.changes.map(change => ({
        label: change.path,
        description: change.action,
        picked: true,
        change
    }));

    const selected = await vscode.window.showQuickPick(items, {
        title: 'Codestral Agent: choisir les fichiers à appliquer',
        placeHolder: 'Décoche les fichiers à rejeter',
        canPickMany: true
    });

    return selected?.map(item => item.change);
}

function getProposedContent(originalContent: string, change: AgentChange): string {
    if (change.unifiedDiff) {
        try {
            return applyUnifiedDiff(originalContent, change.unifiedDiff);
        } catch {
            return change.content ?? originalContent;
        }
    }

    return change.content ?? originalContent;
}

function hashContent(content: string): string {
    let hash = 2166136261;
    for (let i = 0; i < content.length; i++) {
        hash ^= content.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}

function applyUnifiedDiff(originalContent: string, diff: string): string {
    const hunks = parseUnifiedDiffHunks(diff);
    if (hunks.length === 0) {
        throw new Error('Diff unifié sans hunk applicable.');
    }

    try {
        return applyUnifiedDiffStrict(originalContent, hunks);
    } catch {
        return applyUnifiedDiffApproximate(originalContent, hunks);
    }
}

function parseUnifiedDiffHunks(diff: string): DiffHunk[] {
    const diffLines = diff.split(/\r?\n/);
    const hunks: DiffHunk[] = [];
    let current: DiffHunk | undefined;

    for (const line of diffLines) {
        const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (header) {
            current = {
                oldStart: Math.max(Number(header[1]) - 1, 0),
                lines: []
            };
            hunks.push(current);
            continue;
        }

        if (!current) {
            continue;
        }

        if (line === '\\ No newline at end of file') {
            continue;
        }

        if (/^[ +\-]/.test(line)) {
            current.lines.push(line);
        }
    }

    return hunks;
}

function applyUnifiedDiffStrict(originalContent: string, hunks: DiffHunk[]): string {
    const originalLines = originalContent.split(/\r?\n/);
    const result: string[] = [];
    let originalIndex = 0;

    for (const hunk of hunks) {
        const start = hunk.oldStart;
        if (start < originalIndex) {
            throw new Error('Diff hunks overlap or moved backwards.');
        }
        while (originalIndex < start) {
            result.push(originalLines[originalIndex] ?? '');
            originalIndex++;
        }

        for (const hunkLine of hunk.lines) {
            const marker = hunkLine[0];
            const text = hunkLine.slice(1);

            if (marker === ' ') {
                if (originalLines[originalIndex] !== text) {
                    throw new Error('Diff context mismatch.');
                }
                result.push(text);
                originalIndex++;
            } else if (marker === '-') {
                if (originalLines[originalIndex] !== text) {
                    throw new Error('Diff removal mismatch.');
                }
                originalIndex++;
            } else if (marker === '+') {
                result.push(text);
            }
        }
    }

    while (originalIndex < originalLines.length) {
        result.push(originalLines[originalIndex]);
        originalIndex++;
    }

    return result.join('\n');
}

function applyUnifiedDiffApproximate(originalContent: string, hunks: DiffHunk[]): string {
    const lines = originalContent.split(/\r?\n/);
    let offset = 0;

    for (const hunk of hunks) {
        const oldBlock = hunk.lines
            .filter(line => line[0] === ' ' || line[0] === '-')
            .map(line => line.slice(1));
        const newBlock = hunk.lines
            .filter(line => line[0] === ' ' || line[0] === '+')
            .map(line => line.slice(1));
        const expectedIndex = Math.max(0, Math.min(lines.length, hunk.oldStart + offset));
        const index = findBestHunkIndex(lines, oldBlock, expectedIndex);

        if (index < 0) {
            throw new Error('Impossible d’appliquer le diff: contexte introuvable même en mode approximatif.');
        }

        lines.splice(index, oldBlock.length, ...newBlock);
        offset += newBlock.length - oldBlock.length;
    }

    return lines.join('\n');
}

function findBestHunkIndex(lines: string[], oldBlock: string[], expectedIndex: number): number {
    if (oldBlock.length === 0) {
        return expectedIndex;
    }

    const exact = findExactBlock(lines, oldBlock, expectedIndex);
    if (exact >= 0) {
        return exact;
    }

    let bestIndex = -1;
    let bestScore = 0;
    const searchRadius = Math.max(lines.length, 40);
    const start = Math.max(0, expectedIndex - searchRadius);
    const end = Math.min(lines.length, expectedIndex + searchRadius);

    for (let index = start; index <= end; index++) {
        const score = scoreHunkWindow(lines, oldBlock, index);
        if (score > bestScore) {
            bestScore = score;
            bestIndex = index;
        }
    }

    const requiredScore = Math.max(1, Math.ceil(oldBlock.length * 0.6));
    return bestScore >= requiredScore ? bestIndex : -1;
}

function findExactBlock(lines: string[], oldBlock: string[], expectedIndex: number): number {
    const candidates = [
        expectedIndex,
        ...Array.from({ length: Math.min(lines.length, 80) }, (_, index) => index)
    ];
    const seen = new Set<number>();

    for (const candidate of candidates) {
        if (seen.has(candidate) || candidate < 0 || candidate + oldBlock.length > lines.length) {
            continue;
        }
        seen.add(candidate);

        let matches = true;
        for (let i = 0; i < oldBlock.length; i++) {
            if (lines[candidate + i] !== oldBlock[i]) {
                matches = false;
                break;
            }
        }

        if (matches) {
            return candidate;
        }
    }

    return -1;
}

function scoreHunkWindow(lines: string[], oldBlock: string[], index: number): number {
    let score = 0;
    for (let i = 0; i < oldBlock.length; i++) {
        if (lines[index + i] === oldBlock[i]) {
            score += 1;
        }
    }
    return score;
}

async function applyAgentPatch(patch: AgentPatch, workspaceRoot: string): Promise<AgentBackup[]> {
    const backups: AgentBackup[] = [];

    for (const change of patch.changes) {
        const targetUri = resolveWorkspaceFile(workspaceRoot, change.path);
        const original = await readFileState(targetUri);
        if (
            change.baseContentHash
            && (change.action === 'modify' || change.action === 'delete')
            && hashContent(original.content) !== change.baseContentHash
        ) {
            throw new Error(`Conflit détecté: ${change.path} a changé depuis l’affichage du diff.`);
        }
    }

    for (const change of patch.changes) {
        const targetUri = resolveWorkspaceFile(workspaceRoot, change.path);
        const original = await readFileState(targetUri);
        backups.push({
            path: change.path,
            existed: original.existed,
            content: original.content
        });

        if (change.action === 'delete') {
            if (original.existed) {
                await vscode.workspace.fs.delete(targetUri, { recursive: false, useTrash: false });
            }
            continue;
        }

        const parentUri = vscode.Uri.file(path.dirname(targetUri.fsPath));
        await vscode.workspace.fs.createDirectory(parentUri);
        const nextContent = getProposedContent(original.content, change);
        await vscode.workspace.fs.writeFile(
            targetUri,
            Buffer.from(nextContent, 'utf8')
        );
    }

    return backups;
}

async function revertAgentPatch(backups: AgentBackup[], workspaceRoot: string): Promise<void> {
    for (const backup of [...backups].reverse()) {
        const targetUri = resolveWorkspaceFile(workspaceRoot, backup.path);

        if (!backup.existed) {
            try {
                await vscode.workspace.fs.delete(targetUri, { recursive: false, useTrash: false });
            } catch {
                // File may already be gone.
            }
            continue;
        }

        const parentUri = vscode.Uri.file(path.dirname(targetUri.fsPath));
        await vscode.workspace.fs.createDirectory(parentUri);
        await vscode.workspace.fs.writeFile(targetUri, Buffer.from(backup.content, 'utf8'));
    }
}

function resolveWorkspaceFile(workspaceRoot: string, relativePath: string): vscode.Uri {
    const normalized = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, '');
    const targetPath = path.resolve(workspaceRoot, normalized);
    const relative = path.relative(workspaceRoot, targetPath);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Chemin hors workspace refusé: ${relativePath}`);
    }

    return vscode.Uri.file(targetPath);
}

async function readFileIfExists(uri: vscode.Uri): Promise<string> {
    return (await readFileState(uri)).content;
}

async function readFileState(uri: vscode.Uri): Promise<{ existed: boolean; content: string }> {
    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return {
            existed: true,
            content: Buffer.from(bytes).toString('utf8')
        };
    } catch {
        return {
            existed: false,
            content: ''
        };
    }
}

async function openMarkdownDocument(title: string, content: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument({
        content: `## ${title}\n\n${content}`,
        language: 'markdown'
    });

    await vscode.window.showTextDocument(document, { preview: false });
}

function getWorkspaceRoot(): string | undefined {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    return workspaceFolder?.uri.fsPath;
}

async function collectWorkspaceContext(query = ''): Promise<string> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return 'Aucun workspace ouvert.';
    }

    if (workspaceIndexCache.length === 0) {
        workspaceIndexCache = await buildWorkspaceIndex();
    }
    const environmentProfile = await buildProjectEnvironmentProfile(workspaceFolder.uri.fsPath);
    const projectMemory = await readProjectMemory(workspaceFolder.uri.fsPath);

    const files = await vscode.workspace.findFiles(
        '**/*',
        '**/{node_modules,out,.git,dist,build,coverage,.vscode}/**',
        900
    );
    const queryTerms = query
        .toLowerCase()
        .split(/[^a-z0-9_./-]+/i)
        .filter(term => term.length > 2);
    const activeFile = (vscode.window.activeTextEditor ?? lastActiveTextEditor)?.document.uri.toString();
    const explicitTargets = extractExplicitFileTargets(query);
    const candidates: Array<{
        file: vscode.Uri;
        relativePath: string;
        score: number;
        content: string;
        isExplicitTarget: boolean;
    }> = [];

    for (const file of files) {
        const relativePath = vscode.workspace.asRelativePath(file);
        const isActive = file.toString() === activeFile;
        const isExplicitTarget = explicitTargets.some(target => matchesFileTarget(relativePath, target));
        let content = '';
        let contentScore = 0;

        try {
            const bytes = await vscode.workspace.fs.readFile(file);
            content = Buffer.from(bytes).toString('utf8');
            if (content.includes('\u0000') || content.length > 300000) {
                continue;
            }
            contentScore = scoreFileContent(content, queryTerms);
        } catch {
            // Ignore binary or unreadable files.
        }

        candidates.push({
            file,
            relativePath,
            score: scoreWorkspaceFile(relativePath, queryTerms, isActive, isExplicitTarget) + contentScore,
            content,
            isExplicitTarget
        });
    }

    const rankedFiles = candidates
        .sort((a, b) => b.score - a.score)
        .slice(0, shouldScanBroadly(query) ? 56 : 36);
    const linkedFiles = await collectLinkedWorkspaceFiles(rankedFiles, candidates);

    const chunks: string[] = [
        `Workspace: ${workspaceFolder.uri.fsPath}`,
        query ? `Demande/contexte: ${query}` : '',
        '',
        'Profil environnement Codestral:',
        formatProjectEnvironmentProfile(environmentProfile),
        '',
        projectMemory ? 'Mémoire projet Codestral:' : '',
        projectMemory ? formatProjectMemoryForPrompt(projectMemory) : '',
        '',
        'Arborescence projet utile:',
        buildWorkspaceTree(candidates.map(candidate => candidate.relativePath)),
        explicitTargets.length > 0 ? `Cibles explicites détectées: ${explicitTargets.join(', ')}` : '',
        workspaceIndexCache.length > 0 ? 'Index local Codestral:' : '',
        ...workspaceIndexCache
            .slice()
            .sort((a, b) => scoreWorkspaceFile(b.path, queryTerms, false, explicitTargets.some(target => matchesFileTarget(b.path, target))) - scoreWorkspaceFile(a.path, queryTerms, false, explicitTargets.some(target => matchesFileTarget(a.path, target))))
            .slice(0, shouldScanBroadly(query) ? 140 : 64)
            .map(entry => `- ${entry.path} (${entry.language}, ${entry.size} octets): ${entry.summary}`),
        '',
        'Packs de contexte gros projet:',
        ...buildWorkspaceContextPacks(workspaceIndexCache, queryTerms, explicitTargets),
        linkedFiles.length > 0 ? '' : '',
        linkedFiles.length > 0 ? 'Fichiers liés par imports/routes:' : '',
        ...linkedFiles.map(item => `- ${item.relativePath}`),
        '',
        'Aperçu intelligent des fichiers:'
    ];

    for (const item of rankedFiles) {
        const snippetLimit = item.isExplicitTarget ? 9000 : shouldScanBroadly(query) ? 4200 : 3000;
        const snippet = item.content.length > snippetLimit ? item.content.slice(0, snippetLimit) : item.content;

        chunks.push([
            '',
            `--- ${item.relativePath} ---`,
            `Score: ${item.score}${item.isExplicitTarget ? ' (cible explicite)' : ''}`,
            '```',
            snippet,
            '```'
        ].join('\n'));
    }

    for (const item of linkedFiles.slice(0, 18)) {
        const snippet = item.content.length > 2800 ? item.content.slice(0, 2800) : item.content;
        chunks.push([
            '',
            `--- ${item.relativePath} (lié) ---`,
            '```',
            snippet,
            '```'
        ].join('\n'));
    }

    return chunks.join('\n');
}

async function buildWorkspaceIndex(): Promise<WorkspaceIndexEntry[]> {
    const files = await vscode.workspace.findFiles(
        '**/*',
        '**/{node_modules,out,.git,dist,build,coverage,.vscode}/**',
        1000
    );
    const entries: WorkspaceIndexEntry[] = [];

    for (const file of files) {
        try {
            const bytes = await vscode.workspace.fs.readFile(file);
            const content = Buffer.from(bytes).toString('utf8');
            const relativePath = vscode.workspace.asRelativePath(file);

            if (content.includes('\u0000') || content.length > 250000) {
                continue;
            }

            entries.push({
                path: relativePath,
                language: languageFromPath(relativePath),
                size: content.length,
                summary: summarizeFileContent(content),
                updatedAt: Date.now()
            });
        } catch {
            // Ignore unreadable files.
        }
    }

    return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function buildWorkspaceContextPacks(
    entries: WorkspaceIndexEntry[],
    queryTerms: string[],
    explicitTargets: string[]
): string[] {
    const byDirectory = new Map<string, WorkspaceIndexEntry[]>();
    for (const entry of entries) {
        const parts = entry.path.split(/[\\/]/);
        const directory = parts.length > 1 ? parts[0] : '.';
        const group = byDirectory.get(directory) ?? [];
        group.push(entry);
        byDirectory.set(directory, group);
    }

    return Array.from(byDirectory.entries())
        .map(([directory, files]) => {
            const score = files.reduce((total, file) => {
                return total + scoreWorkspaceFile(
                    file.path,
                    queryTerms,
                    false,
                    explicitTargets.some(target => matchesFileTarget(file.path, target))
                );
            }, 0);
            const languages = Array.from(new Set(files.map(file => file.language))).sort();
            const importantFiles = files
                .slice()
                .sort((a, b) => scoreWorkspaceFile(b.path, queryTerms, false, explicitTargets.some(target => matchesFileTarget(b.path, target)))
                    - scoreWorkspaceFile(a.path, queryTerms, false, explicitTargets.some(target => matchesFileTarget(a.path, target))))
                .slice(0, 8)
                .map(file => file.path)
                .join(', ');

            return {
                directory,
                score,
                text: `- ${directory}: ${files.length} fichier(s), ${languages.join(', ')}. Fichiers clés: ${importantFiles || 'aucun'}`
            };
        })
        .sort((a, b) => b.score - a.score || a.directory.localeCompare(b.directory))
        .slice(0, 40)
        .map(item => item.text);
}

function languageFromPath(relativePath: string): string {
    const ext = path.extname(relativePath).replace('.', '').toLowerCase();
    return ext || 'text';
}

function summarizeFileContent(content: string): string {
    const lines = content
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('//') && !line.startsWith('#'))
        .slice(0, 8);
    const summary = lines.join(' ').slice(0, 240);
    return summary || 'Fichier vide ou principalement commentaires.';
}

function scoreWorkspaceFile(
    relativePath: string,
    queryTerms: string[],
    isActiveFile: boolean,
    isExplicitTarget = false
): number {
    const lowerPath = relativePath.toLowerCase();
    let score = isActiveFile ? 120 : 0;

    if (isExplicitTarget) {
        score += 180;
    }

    if (/^(readme|package|requirements|pyproject|cargo|go\.mod|pom\.xml|build\.gradle)/i.test(relativePath)) {
        score += 35;
    }

    if (/\.(ts|tsx|js|jsx|py|java|go|rs|cpp|c|h|css|html|json|md)$/i.test(relativePath)) {
        score += 10;
    }

    if (/(test|spec|__tests__)/i.test(relativePath)) {
        score += 8;
    }

    for (const term of queryTerms) {
        if (lowerPath.includes(term)) {
            score += 25;
        }
    }

    return score;
}

function scoreFileContent(content: string, queryTerms: string[]): number {
    if (queryTerms.length === 0) {
        return 0;
    }

    const lowerContent = content.toLowerCase().slice(0, 80000);
    let score = 0;
    for (const term of queryTerms) {
        if (term.length < 3 || /^(the|and|pour|avec|dans|que|qui|les|des|une|sur|this|that|with|from)$/.test(term)) {
            continue;
        }
        const matches = lowerContent.split(term).length - 1;
        score += Math.min(matches * 7, 42);
    }

    return score;
}

function extractExplicitFileTargets(query: string): string[] {
    const matches = query.match(/[\w./-]+\.[a-z0-9]{1,8}/gi) ?? [];
    return Array.from(new Set(matches.map(match => match.replace(/^[/\\]+/, '').toLowerCase())));
}

function matchesFileTarget(relativePath: string, target: string): boolean {
    const lowerPath = relativePath.toLowerCase();
    const lowerTarget = target.toLowerCase();
    return lowerPath === lowerTarget || lowerPath.endsWith(`/${lowerTarget}`) || path.basename(lowerPath) === lowerTarget;
}

function shouldScanBroadly(query: string): boolean {
    return /\b(tout|tous|entier|projet|workspace|global|partout|all|whole|entire|project)\b/i.test(query);
}

function buildWorkspaceTree(relativePaths: string[]): string {
    const interesting = relativePaths
        .filter(filePath => !/(^|\/)(node_modules|out|dist|build|coverage|\.git)(\/|$)/.test(filePath))
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 180);

    return interesting.map(filePath => `- ${filePath}`).join('\n');
}

async function collectLinkedWorkspaceFiles(
    rankedFiles: Array<{ relativePath: string; content: string }>,
    candidates: Array<{ relativePath: string; content: string }>
): Promise<Array<{ relativePath: string; content: string }>> {
    const candidateMap = new Map(candidates.map(candidate => [candidate.relativePath, candidate]));
    const selectedPaths = new Set(rankedFiles.map(file => file.relativePath));
    const linked = new Map<string, { relativePath: string; content: string }>();
    const queue = rankedFiles.slice(0, 14).map(file => ({ file, depth: 0 }));
    const visited = new Set<string>();

    while (queue.length > 0 && linked.size < 48) {
        const current = queue.shift();
        if (!current || visited.has(current.file.relativePath) || current.depth > 2) {
            continue;
        }

        visited.add(current.file.relativePath);
        const file = current.file;
        const imports = extractImportTargets(file.content);
        for (const importTarget of imports) {
            const resolved = resolveImportTarget(file.relativePath, importTarget, candidateMap);
            if (!resolved || selectedPaths.has(resolved.relativePath)) {
                continue;
            }

            if (!linked.has(resolved.relativePath)) {
                linked.set(resolved.relativePath, resolved);
            }

            if (current.depth < 2) {
                queue.push({ file: resolved, depth: current.depth + 1 });
            }
        }
    }

    return Array.from(linked.values());
}

function extractImportTargets(content: string): string[] {
    const targets: string[] = [];
    const patterns = [
        /import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g,
        /export\s+[^'"]+\s+from\s+['"]([^'"]+)['"]/g,
        /require\(\s*['"]([^'"]+)['"]\s*\)/g,
        /href=["']([^"']+)["']/g,
        /src=["']([^"']+)["']/g
    ];

    for (const pattern of patterns) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) {
            if (match[1] && !match[1].startsWith('http') && !match[1].startsWith('#')) {
                targets.push(match[1]);
            }
        }
    }

    return Array.from(new Set(targets));
}

function resolveImportTarget(
    fromPath: string,
    importTarget: string,
    candidates: Map<string, { relativePath: string; content: string }>
): { relativePath: string; content: string } | undefined {
    const baseDir = path.posix.dirname(fromPath.replace(/\\/g, '/'));
    const rawTarget = importTarget.startsWith('.')
        ? path.posix.normalize(path.posix.join(baseDir, importTarget))
        : importTarget.replace(/^\/+/, '');
    const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.html', '.json'];
    const indexFiles = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.css', 'index.html'];

    for (const ext of extensions) {
        const direct = candidates.get(`${rawTarget}${ext}`);
        if (direct) {
            return direct;
        }
    }

    for (const indexFile of indexFiles) {
        const indexed = candidates.get(path.posix.join(rawTarget, indexFile));
        if (indexed) {
            return indexed;
        }
    }

    return undefined;
}

function runShellCommand(
    command: string,
    cwd: string,
    outputChannel?: vscode.OutputChannel
): Promise<string> {
    return runShellCommandDetailed(command, cwd, outputChannel).then(result => result.output);
}

async function detectDevServerCommand(workspaceRoot: string): Promise<string> {
    const packageJson = await readJsonIfExists(vscode.Uri.file(path.join(workspaceRoot, 'package.json')));
    if (packageJson && typeof packageJson === 'object') {
        const scripts = (packageJson as { scripts?: Record<string, unknown> }).scripts ?? {};
        for (const name of ['dev', 'start', 'serve', 'preview']) {
            if (typeof scripts[name] === 'string' && scripts[name].trim()) {
                return name === 'start' ? 'npm start' : `npm run ${name}`;
            }
        }
    }

    if (await fileExists(path.join(workspaceRoot, 'index.html'))) {
        return 'python -m http.server 5173';
    }

    if (await fileExists(path.join(workspaceRoot, 'manage.py'))) {
        return 'python manage.py runserver';
    }

    return 'npm run dev';
}

async function startDevServer(
    command: string,
    cwd: string,
    outputChannel?: vscode.OutputChannel
): Promise<void> {
    if (activeDevServerProcess) {
        const choice = await vscode.window.showWarningMessage(
            'Un serveur dev Codestral est déjà en cours. Le redémarrer ?',
            { modal: true },
            'Redémarrer',
            'Annuler'
        );

        if (choice !== 'Redémarrer') {
            return;
        }

        activeDevServerProcess.kill('SIGTERM');
        activeDevServerProcess = undefined;
    }

    outputChannel?.clear();
    outputChannel?.show(true);
    outputChannel?.appendLine(`[Codestral Dev] $ ${command}`);
    outputChannel?.appendLine(`[Codestral Dev] cwd: ${cwd}`);
    outputChannel?.appendLine('');

    const child = childProcess.spawn(command, {
        cwd,
        shell: true,
        env: buildCommandEnvironment()
    });
    let openedUrl = false;
    let smokedUrl = false;
    activeDevServerProcess = child;
    lastDevServerCommand = { command, cwd };

    const fallbackUrl = inferDevServerUrl(command);
    if (fallbackUrl) {
        setTimeout(() => {
            if (!openedUrl && activeDevServerProcess === child) {
                openedUrl = true;
                vscode.env.openExternal(vscode.Uri.parse(fallbackUrl));
                if (!smokedUrl) {
                    smokedUrl = true;
                    void smokeDevServerUrl(fallbackUrl, outputChannel);
                }
            }
        }, 1800);
    }

    const handleOutput = (data: Buffer): void => {
        const text = data.toString();
        outputChannel?.append(text);
        if (!openedUrl) {
            const url = detectLocalDevUrl(text);
            if (url) {
                openedUrl = true;
                vscode.env.openExternal(vscode.Uri.parse(url));
                if (!smokedUrl) {
                    smokedUrl = true;
                    void smokeDevServerUrl(url, outputChannel);
                }
            }
        }
    };

    child.stdout.on('data', handleOutput);
    child.stderr.on('data', handleOutput);
    child.on('error', (error) => {
        outputChannel?.appendLine(`\n[Codestral Dev] ERROR: ${error.message}`);
        vscode.window.showErrorMessage(`Codestral Dev Server: ${error.message}`);
    });
    child.on('close', (code) => {
        outputChannel?.appendLine(`\n[Codestral Dev] stopped: ${code ?? 'unknown'}`);
        if (activeDevServerProcess === child) {
            activeDevServerProcess = undefined;
        }
    });

    vscode.window.showInformationMessage(`Codestral Dev Server lancé: ${command}`);
}

function detectLocalDevUrl(text: string): string | undefined {
    const match = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+(?:\/[^\s"'<>]*)?/i);
    if (!match) {
        return undefined;
    }

    return match[0].replace('0.0.0.0', 'localhost');
}

function inferDevServerUrl(command: string): string | undefined {
    const portMatch = command.match(/\b(?:--port|-p)?\s*(\d{4,5})\b/);
    const port = portMatch ? portMatch[1] : /http\.server/i.test(command) ? '5173' : undefined;
    return port ? `http://localhost:${port}` : undefined;
}

async function smokeDevServerUrl(url: string, outputChannel?: vscode.OutputChannel): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 1200));
    try {
        const result = await requestUrl(url, 5000);
        const ok = result.statusCode >= 200 && result.statusCode < 500;
        outputChannel?.appendLine(`\n[Codestral Dev] smoke ${url}: HTTP ${result.statusCode}${ok ? ' OK' : ' ERROR'}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel?.appendLine(`\n[Codestral Dev] smoke ${url}: ERROR ${message}`);
    }
}

function requestUrl(url: string, timeoutMs: number): Promise<{ statusCode: number }> {
    return new Promise((resolve, reject) => {
        const uri = new URL(url);
        const client = uri.protocol === 'https:' ? https : http;
        const req = client.request(uri, { method: 'GET', timeout: timeoutMs }, (res) => {
            res.resume();
            resolve({ statusCode: res.statusCode ?? 0 });
        });

        req.on('timeout', () => {
            req.destroy(new Error(`timeout after ${timeoutMs}ms`));
        });
        req.on('error', reject);
        req.end();
    });
}

async function runValidationCommands(
    commands: ValidationCommand[],
    cwd: string,
    outputChannel?: vscode.OutputChannel
): Promise<CommandResult> {
    const outputs: string[] = [];
    for (const item of commands) {
        outputChannel?.appendLine(`\n[Codestral Agent] ${item.label}: ${item.command}`);
        const result = item.kind === 'static-smoke'
            ? await runStaticSmokeCheck(item.files ?? [], cwd, outputChannel)
            : await runShellCommandDetailed(item.command, cwd, outputChannel);
        outputs.push([
            `$ ${item.command}`,
            `exit: ${result.exitCode ?? 'unknown'}`,
            result.output
        ].join('\n'));
        if (result.exitCode !== 0) {
            return {
                output: outputs.join('\n\n'),
                exitCode: result.exitCode
            };
        }
    }

    return {
        output: outputs.join('\n\n') || 'Validation terminée sans sortie.',
        exitCode: 0
    };
}

async function runStaticSmokeCheck(
    htmlFiles: string[],
    workspaceRoot: string,
    outputChannel?: vscode.OutputChannel
): Promise<CommandResult> {
    const candidates = htmlFiles.length > 0
        ? htmlFiles
        : (await vscode.workspace.findFiles('**/*.html', '**/{.git,node_modules,out,dist,build,coverage}/**', 12))
            .map(file => vscode.workspace.asRelativePath(file));
    const checkedFiles = Array.from(new Set(candidates)).slice(0, 12);
    const missing: string[] = [];
    const checkedRefs: string[] = [];

    for (const relativeHtmlPath of checkedFiles) {
        const htmlUri = resolveWorkspaceFile(workspaceRoot, relativeHtmlPath);
        const html = await readFileIfExists(htmlUri);
        const refs = extractHtmlLocalReferences(html);
        for (const ref of refs) {
            const cleanRef = ref.split(/[?#]/)[0];
            if (!cleanRef || cleanRef.startsWith('/')) {
                continue;
            }

            const targetPath = path.normalize(path.join(path.dirname(relativeHtmlPath), cleanRef));
            checkedRefs.push(`${relativeHtmlPath} -> ${cleanRef}`);
            if (!await fileExists(path.join(workspaceRoot, targetPath))) {
                missing.push(`${relativeHtmlPath}: ${cleanRef}`);
            }
        }
    }

    const output = [
        `HTML vérifiés: ${checkedFiles.length ? checkedFiles.join(', ') : 'aucun'}`,
        `Références locales vérifiées: ${checkedRefs.length}`,
        missing.length > 0 ? 'Références manquantes:' : 'Smoke check statique OK.',
        ...missing.map(item => `- ${item}`)
    ].join('\n');
    outputChannel?.appendLine(output);

    return {
        output,
        exitCode: missing.length > 0 ? 1 : 0
    };
}

function extractHtmlLocalReferences(html: string): string[] {
    const refs: string[] = [];
    const pattern = /\b(?:src|href)=["']([^"']+)["']/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
        const ref = match[1].trim();
        if (
            ref
            && !/^(?:https?:|mailto:|tel:|data:|#|javascript:)/i.test(ref)
        ) {
            refs.push(ref);
        }
    }
    return Array.from(new Set(refs));
}

function runShellCommandDetailed(
    command: string,
    cwd: string,
    outputChannel?: vscode.OutputChannel
): Promise<CommandResult> {
    return new Promise((resolve) => {
        const safetyError = validateShellCommandSafety(command, cwd);
        if (safetyError) {
            outputChannel?.show(true);
            outputChannel?.appendLine(`[Codestral Sandbox] Command blocked: ${safetyError}`);
            resolve({
                output: `[Codestral Sandbox] Command blocked: ${safetyError}`,
                exitCode: 126
            });
            return;
        }

        lastShellCommand = { command, cwd };
        outputChannel?.clear();
        outputChannel?.show(true);
        outputChannel?.appendLine(`$ ${command}`);
        outputChannel?.appendLine(`cwd: ${cwd}`);
        outputChannel?.appendLine('');

        const child = childProcess.spawn(command, {
            cwd,
            shell: true,
            env: buildCommandEnvironment()
        });
        activeCommandProcess = child;
        const chunks: string[] = [];
        const timeout = setTimeout(() => {
            outputChannel?.appendLine('\n[Codestral Agent] Command timed out after 120s.');
            child.kill();
        }, 120000);

        child.stdout.on('data', (data: Buffer) => {
            const text = data.toString();
            chunks.push(text);
            outputChannel?.append(text);
        });

        child.stderr.on('data', (data: Buffer) => {
            const text = data.toString();
            chunks.push(text);
            outputChannel?.append(text);
        });

        child.on('error', (error) => {
            chunks.push(`\nERROR:\n${error.message}`);
            outputChannel?.appendLine(`\nERROR: ${error.message}`);
        });

        child.on('close', async (code) => {
            clearTimeout(timeout);
            if (activeCommandProcess === child) {
                activeCommandProcess = undefined;
            }
            outputChannel?.appendLine(`\n[Codestral Agent] Exit code: ${code ?? 'unknown'}`);
            const output = chunks.join('') || 'Commande terminée sans sortie.';
            if (code !== 0 && shouldAskForPrivilegeElevation(output)) {
                await maybeOpenElevatedTerminal(command, cwd, outputChannel);
            }
            resolve({
                output,
                exitCode: code
            });
        });
    });
}

function validateShellCommandSafety(command: string, cwd: string): string | undefined {
    const config = vscode.workspace.getConfiguration('codestral-ai');
    if (config.get<boolean>('allowRiskyShellCommands', false)) {
        return undefined;
    }

    const workspaceRoot = getWorkspaceRoot();
    if (workspaceRoot) {
        const relative = path.relative(workspaceRoot, cwd);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            return `cwd hors workspace refusé: ${cwd}`;
        }
    }

    const normalized = command.toLowerCase().replace(/\s+/g, ' ').trim();
    const dangerousPatterns = [
        /\brm\s+(-[a-z]*r[a-z]*f|-f[a-z]*r|-r[a-z]*f)\b/,
        /\bsudo\s+rm\b/,
        /\bgit\s+reset\s+--hard\b/,
        /\bgit\s+clean\s+-[a-z]*f[a-z]*d?\b/,
        /\bmkfs(?:\.[a-z0-9]+)?\b/,
        /\bdd\s+.*\bof=\/dev\//,
        />\s*\/(?:etc|usr|bin|sbin|boot|dev|proc|sys)\b/,
        /\bchmod\s+(-r\s+)?777\b/,
        /\bchown\s+(-r\s+)?[^&|;]+\/(?:etc|usr|bin|sbin|boot)\b/
    ];

    if (dangerousPatterns.some(pattern => pattern.test(normalized))) {
        return `commande potentiellement destructive refusée: ${command}`;
    }

    return undefined;
}

function buildCommandEnvironment(): NodeJS.ProcessEnv {
    const config = vscode.workspace.getConfiguration('codestral-ai');
    if (config.get<boolean>('inheritSensitiveEnv', false)) {
        return process.env;
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
        if (/(api|token|secret|password|credential|key)$/i.test(key) || /_(api|token|secret|password|credential|key)_?/i.test(key)) {
            delete env[key];
        }
    }

    return env;
}

function shouldAskForPrivilegeElevation(output: string): boolean {
    const config = vscode.workspace.getConfiguration('codestral-ai');
    if (!config.get<boolean>('askForPrivilegeElevation', true)) {
        return false;
    }

    return /(permission denied|eacces|eperm|operation not permitted|requires root|must be root|are you root|access is denied)/i.test(output);
}

async function maybeOpenElevatedTerminal(
    command: string,
    cwd: string,
    outputChannel?: vscode.OutputChannel
): Promise<void> {
    if (/^\s*sudo\b/.test(command)) {
        return;
    }

    const choice = await vscode.window.showWarningMessage(
        `La commande semble bloquée par les permissions:\n${command}\n\nRelancer avec sudo dans un terminal ?`,
        { modal: true },
        'Relancer avec sudo',
        'Ignorer'
    );

    if (choice !== 'Relancer avec sudo') {
        return;
    }

    const terminal = vscode.window.createTerminal({
        name: 'Codestral Elevated',
        cwd
    });
    terminal.show(true);
    terminal.sendText(`sudo ${command}`);
    outputChannel?.appendLine('[Codestral Agent] Elevated terminal opened. Password is handled by the terminal.');
}

function callCodestralCompletion(
    apiKey: string,
    prompt: string,
    maxTokens: number,
    temperature: number,
    model: string
): Promise<string> {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            model,
            prompt: prompt,
            max_tokens: maxTokens,
            temperature: temperature
        });

        const options: https.RequestOptions = {
            hostname: 'codestral.mistral.ai',
            path: '/v1/fim/completions',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                    return;
                }

                try {
                    const response: CodestralCompletionResponse = JSON.parse(data);
                    lastTokenUsage = response.usage;
                    void extensionContextRef?.globalState.update('lastTokenUsage', lastTokenUsage);
                    if (response.choices && response.choices.length > 0) {
                        resolve(response.choices[0].text);
                    } else {
                        resolve('');
                    }
                } catch (e) {
                    reject(new Error(`Erreur de parsing: ${e instanceof Error ? e.message : String(e)}`));
                }
            });
        });

        req.on('error', (e) => {
            reject(e);
        });

        req.write(payload);
        req.end();
    });
}

function callCodestralChat(
    apiKey: string,
    message: string,
    maxTokens: number,
    temperature: number,
    model: string
): Promise<string> {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            model,
            messages: [{ role: 'user', content: message }],
            max_tokens: maxTokens,
            temperature: temperature
        });

        const options: https.RequestOptions = {
            hostname: 'codestral.mistral.ai',
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                    return;
                }

                try {
                    const response: CodestralChatResponse = JSON.parse(data);
                    lastTokenUsage = response.usage;
                    void extensionContextRef?.globalState.update('lastTokenUsage', lastTokenUsage);
                    if (response.choices && response.choices.length > 0) {
                        resolve(response.choices[0].message.content);
                    } else {
                        resolve('');
                    }
                } catch (e) {
                    reject(new Error(`Erreur de parsing: ${e instanceof Error ? e.message : String(e)}`));
                }
            });
        });

        req.on('error', (e) => {
            reject(e);
        });

        req.write(payload);
        req.end();
    });
}

function withResponseLanguage(prompt: string, config: vscode.WorkspaceConfiguration): string {
    const responseLanguage = config.get<string>('responseLanguage', 'français').trim();
    if (!responseLanguage) {
        return prompt;
    }

    return [
        `Réponds en ${responseLanguage}.`,
        '',
        prompt
    ].join('\n');
}

function listMistralModels(apiKey: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const options: https.RequestOptions = {
            hostname: 'api.mistral.ai',
            path: '/v1/models',
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Accept': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                    return;
                }

                try {
                    const response: MistralModelsResponse = JSON.parse(data);
                    const models = (response.data ?? [])
                        .map(model => model.id)
                        .filter((model): model is string => typeof model === 'string' && model.length > 0)
                        .sort((a, b) => a.localeCompare(b));
                    resolve(models);
                } catch (e) {
                    reject(new Error(`Erreur de parsing: ${e instanceof Error ? e.message : String(e)}`));
                }
            });
        });

        req.on('error', (e) => {
            reject(e);
        });

        req.end();
    });
}

export function deactivate() {}
