/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/sessionCanvas.css';
import { getZoomFactor, onDidChangeZoomLevel } from '../../../../base/browser/browser.js';
import { $, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, observableValue } from '../../../../base/common/observable.js';
import { isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { AccessibilityVerbositySettingId } from '../../accessibility/browser/accessibilityConfiguration.js';
import { IBrowserViewModel, IBrowserViewWorkbenchService } from '../../browserView/common/browserView.js';
import { focusWebContentsViewContainer, WebContentsViewHost } from '../../browserView/electron-browser/webContentsViewHost.js';
import { IEditorGroup, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { CanvasInput, ICanvasService } from '../common/canvas.js';

export const SessionCanvasFocusedContext = new RawContextKey<boolean>('sessionCanvasFocused', false);

export class CanvasEditor extends EditorPane {

	static readonly ID = CanvasInput.EDITOR_ID;

	private wrapper!: HTMLElement;
	private container!: HTMLElement;
	private message!: HTMLElement;
	private host!: WebContentsViewHost;
	private model: IBrowserViewModel | undefined;
	private readonly modelLifetime = this._register(new DisposableStore());
	private readonly browserModel = this._register(new MutableDisposable<IBrowserViewModel>());
	private readonly pendingVisibleLayout = this._register(new MutableDisposable());
	private readonly currentInput = observableValue<CanvasInput | undefined>(this, undefined);
	private readonly editorVisible = observableValue(this, false);
	private readonly presentationVisible = observableValue(this, false);
	private readonly semanticChanged = this._register(new Emitter<void>());
	private loadSequence = 0;
	private loadingKey: string | undefined;
	private loadedKey: string | undefined;
	private semanticSequence = 0;
	private semanticText = '';
	private helpAnnounced = false;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@ICanvasService private readonly canvasService: ICanvasService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IBrowserViewWorkbenchService private readonly browserViewService: IBrowserViewWorkbenchService,
		@IAccessibilityService private readonly accessibilityService: IAccessibilityService,
		@IAccessibleViewService private readonly accessibleViewService: IAccessibleViewService,
		@ILogService private readonly logService: ILogService,
	) {
		super(CanvasEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		const scopedContextKeyService = this._register(this.contextKeyService.createScoped(parent));
		SessionCanvasFocusedContext.bindTo(scopedContextKeyService).set(true);

		const root = $('.browser-root.session-canvas-editor');
		this.wrapper = $('.browser-container-wrapper');
		this.container = $('.browser-container');
		this.container.tabIndex = 0;
		this.container.setAttribute('role', 'group');
		this.container.setAttribute('aria-label', localize('canvas.content', "Canvas content. Use Accessibility Help for keyboard navigation."));
		const placeholder = $('.browser-placeholder-contents');
		this.message = $('.session-canvas-message');
		this.message.setAttribute('role', 'status');
		placeholder.appendChild(this.message);
		this.container.appendChild(placeholder);
		this.wrapper.appendChild(this.container);
		root.appendChild(this.wrapper);
		parent.appendChild(root);

		this.host = this._register(this.instantiationService.createInstance(WebContentsViewHost, this.window, () => focusWebContentsViewContainer(this.container)));
		placeholder.append(this.host.screenshotElement, this.host.pauseElement);
		this.host.onContainerCreated(this.container);

		this._register(onDidChangeZoomLevel(windowId => {
			if (windowId === this.group.windowId) {
				this.layout();
			}
		}));
		this._register(autorun(reader => {
			const input = this.currentInput.read(reader);
			if (!input || !this.canvasService.enabled.read(reader) || !this.canvasService.isOwnerPresentable(input.reference, reader)) {
				this._detach(localize('canvas.ownerUnavailable', "This canvas is only shown beside its owning conversation."));
				return;
			}
			const canvas = input.canvas.read(reader);
			if (!canvas) {
				this._detach(localize('canvas.closed', "This canvas is no longer available."));
				return;
			}
			if (canvas.source === undefined) {
				this._detach(localize('canvas.unavailable', "The canvas provider is temporarily unavailable."));
				return;
			}
			const key = `${canvas.resource.toString()}\u0000${canvas.source.toString()}`;
			if (this.loadingKey !== key && this.loadedKey !== key) {
				void this._load(input, key);
			}
		}));
	}

	override async setInput(input: CanvasInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		if (this.group.windowId !== this.editorGroupsService.mainPart.windowId) {
			throw new Error(localize('canvas.mainWindowOnly', "Canvases can only be shown in the main window beside their owning conversation."));
		}
		this.currentInput.set(undefined, undefined);
		await super.setInput(input, options, context, token);
		if (!token.isCancellationRequested && this.input === input) {
			this.currentInput.set(input, undefined);
		}
	}

	private async _load(input: CanvasInput, key: string): Promise<void> {
		const canvas = input.canvas.get();
		if (canvas === undefined || canvas.source === undefined) {
			return;
		}
		this._detach(localize('canvas.loading', "Loading canvas…"));
		const sequence = ++this.loadSequence;
		this.loadingKey = key;
		try {
			const source = canvas.source;
			const model = await this.browserViewService.createExternalBrowserView(source.toString(true));
			if (!this._isCurrent(input, source, sequence)) {
				model.dispose();
				return;
			}
			this._setModel(model);
			this.browserModel.value = model;
			this.message.textContent = localize('canvas.pageLoading', "Loading canvas page…");
			this.loadedKey = key;
			this.message.textContent = model.error ? localize('canvas.pageFailed', "The canvas page failed to load.") : '';
		} catch {
			if (this._isCurrent(input, canvas.source, sequence)) {
				this._detach(localize('canvas.loadFailed', "The canvas could not be loaded."));
				this.logService.error('[CanvasEditor] Failed to load canvas');
			}
		} finally {
			if (sequence === this.loadSequence && this.loadingKey === key) {
				this.loadingKey = undefined;
			}
		}
	}

	private _isCurrent(input: CanvasInput, source: URI, sequence: number): boolean {
		return !this._store.isDisposed
			&& sequence === this.loadSequence
			&& this.currentInput.get() === input
			&& isEqual(input.canvas.get()?.source, source)
			&& this.canvasService.isOwnerPresentable(input.reference);
	}

	private _setModel(model: IBrowserViewModel | undefined): void {
		if (this.model === model) {
			return;
		}
		this.modelLifetime.clear();
		this.model = model;
		this.host.setModel(model);
		this.invalidateSemanticContent();
		this.helpAnnounced = false;
		if (!model) {
			return;
		}
		this.modelLifetime.add(model.onDidChangeFocus(event => {
			if (!event.focused) {
				return;
			}
			this._onDidFocus?.fire();
			focusWebContentsViewContainer(this.container);
			if (!this.helpAnnounced && this.accessibilityService.isScreenReaderOptimized()) {
				const hint = this.accessibleViewService.getOpenAriaHint(AccessibilityVerbositySettingId.SessionCanvas);
				if (hint) {
					status(hint);
				}
				this.helpAnnounced = true;
			}
		}));
		this.modelLifetime.add(model.onDidChangeLoadingState(event => {
			this.message.textContent = event.error
				? localize('canvas.pageFailed', "The canvas page failed to load.")
				: event.loading ? localize('canvas.pageLoading', "Loading canvas page…") : '';
		}));
		this.modelLifetime.add(model.onDidNavigate(() => this.invalidateSemanticContent()));
		this.modelLifetime.add(model.onWillDispose(() => {
			if (this.model !== model) {
				return;
			}
			this.model = undefined;
			this.loadedKey = undefined;
			this.host.setModel(undefined);
			const input = this.currentInput.get();
			const canvas = input?.canvas.get();
			if (input && canvas?.source && this.canvasService.isOwnerPresentable(input.reference)) {
				void this._load(input, `${canvas.resource.toString()}\u0000${canvas.source.toString()}`);
			}
		}));
		this.host.setVisible(this.editorVisible.get());
		this.layout();
	}

	private _detach(message: string, disposeInput = true): void {
		this.loadSequence++;
		this.loadingKey = undefined;
		this.loadedKey = undefined;
		this._setModel(undefined);
		if (disposeInput) {
			this.browserModel.clear();
		}
		this.message.textContent = message;
	}

	override layout(): void {
		if (!this.model) {
			return;
		}
		const rect = this.wrapper.getBoundingClientRect();
		const zoomFactor = getZoomFactor(this.window);
		const snap = (value: number) => Math.floor(value * zoomFactor) / zoomFactor;
		const x = snap(rect.left);
		const y = snap(rect.top);
		const width = snap(rect.width);
		const height = snap(rect.height);
		const visible = this.editorVisible.get()
			&& width > 0
			&& height > 0
			&& rect.right > 0
			&& rect.bottom > 0
			&& rect.left < this.window.innerWidth
			&& rect.top < this.window.innerHeight;
		this.presentationVisible.set(visible, undefined);
		this.host.setVisible(visible);
		this.container.style.left = `${x - rect.left}px`;
		this.container.style.top = `${y - rect.top}px`;
		this.container.style.width = `${width}px`;
		this.container.style.height = `${height}px`;
		void this.model.layout({ x, y, width, height, windowId: this.group.windowId, zoomFactor, cornerRadius: 0 })
			.catch(error => this.logService.error('[CanvasEditor] Failed to layout canvas', error));
		this.host.layout();
	}

	protected override setEditorVisible(visible: boolean): void {
		this.editorVisible.set(visible, undefined);
		if (!visible) {
			this.presentationVisible.set(false, undefined);
		}
		this.host?.setVisible(visible);
		this.pendingVisibleLayout.clear();
		if (visible) {
			this.pendingVisibleLayout.value = scheduleAtNextAnimationFrame(this.window, () => {
				if (this.editorVisible.get()) {
					this.layout();
				}
			});
		}
	}

	override focus(): void {
		if (!this.host.tryFocus()) {
			this.container.focus();
		}
	}

	override clearInput(): void {
		this.currentInput.set(undefined, undefined);
		this._detach('');
		super.clearInput();
	}

	override dispose(): void {
		this.currentInput.set(undefined, undefined);
		this._detach('');
		super.dispose();
	}

	createAccessibleProvider(type: AccessibleViewType): AccessibleContentProvider {
		const input = this.input;
		const help = [
			localize('canvas.help.overview', "This canvas is a private page owned by its conversation. Its content is available while that conversation is shown."),
			localize('canvas.help.navigation', "Tab moves through page controls. Use <keybinding:workbench.action.focusNextPart> to leave the page."),
			localize('canvas.help.close', "Closing the tab hides this canvas. Ask the agent to reopen it, or choose its title from Add Tab in the Agents Window while it remains available."),
		].join('\n\n');
		this.semanticText = localize('canvas.reading', "Reading accessible canvas content…");
		return new AccessibleContentProvider(
			AccessibleViewProviderId.SessionCanvas,
			{ type, language: 'plaintext' },
			() => type === AccessibleViewType.Help ? help : this.semanticText,
			() => {
				if (input instanceof CanvasInput && this.input === input && this.presentationVisible.get() && this.canvasService.isOwnerPresentable(input.reference)) {
					this.focus();
				}
			},
			AccessibilityVerbositySettingId.SessionCanvas,
			type === AccessibleViewType.View ? () => { void this.refreshSemanticContent(); } : undefined,
			undefined,
			undefined,
			undefined,
			this.semanticChanged.event,
		);
	}

	private invalidateSemanticContent(): void {
		this.semanticSequence++;
		this.semanticText = localize('canvas.semanticChanged', "The canvas changed. Reopen Accessible View to read its current content.");
		this.semanticChanged.fire();
	}

	private async refreshSemanticContent(): Promise<void> {
		const model = this.model;
		const sequence = ++this.semanticSequence;
		if (!model) {
			this.semanticText = localize('canvas.noPage', "No canvas page is currently attached.");
		} else {
			try {
				const snapshot = await model.getAccessibilitySnapshot();
				if (this.model !== model || sequence !== this.semanticSequence || this._store.isDisposed) {
					return;
				}
				this.semanticText = snapshot.text || localize('canvas.noSemantics', "This canvas exposes no named accessible content.");
				if (snapshot.truncated) {
					this.semanticText += '\n\n' + localize('canvas.truncated', "The bounded accessible snapshot is incomplete.");
				}
			} catch (error) {
				if (this.model !== model || sequence !== this.semanticSequence || this._store.isDisposed) {
					return;
				}
				this.semanticText = localize('canvas.semanticError', "The canvas accessible content could not be read.");
				this.logService.error('[CanvasEditor] Failed to read accessible canvas content', error);
			}
		}
		this.semanticChanged.fire();
	}
}
