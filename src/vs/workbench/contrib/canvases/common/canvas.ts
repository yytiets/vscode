/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Event } from '../../../../base/common/event.js';
import { IObservable, IReader, observableValue } from '../../../../base/common/observable.js';
import { isEqual } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInputCapabilities, GroupIdentifier, IUntypedEditorInput, Verbosity } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';

export interface ICanvas {
	readonly resource: URI;
	readonly instanceId: string | undefined;
	readonly title: string;
	readonly status?: string;
	readonly source: URI | undefined;
}

export interface ICanvasOwner {
	readonly providerId: string;
	readonly session: URI;
	readonly chat: URI;
}

export interface ICanvasReference extends ICanvasOwner {
	readonly canvas: URI;
}

export interface ICanvasReopenTarget {
	readonly reference: ICanvasReference;
	readonly canvas: ICanvas;
}

export interface ICanvasContext {
	readonly owner: ICanvasOwner;
	readonly canvases: IObservable<readonly ICanvas[] | undefined>;
	readonly openRequests?: IObservable<ReadonlyMap<string, ICanvasOpenRequest>>;
}

export interface ICanvasOpenRequest {
	readonly id: string;
	readonly succeeded: boolean;
}

export const ICanvasContextService = createDecorator<ICanvasContextService>('canvasContextService');

export interface ICanvasContextService {
	readonly _serviceBrand: undefined;
	readonly contexts: IObservable<readonly ICanvasContext[]>;
	readonly onDidRemoveOwner: Event<ICanvasOwner>;
	isOwnerVisible(owner: ICanvasOwner, reader?: IReader): boolean;
	getEditorGroup(owner: ICanvasOwner, input: CanvasInput): IEditorGroup | undefined;
}

export const ICanvasService = createDecorator<ICanvasService>('sessionCanvasService');

export interface ICanvasService {
	readonly _serviceBrand: undefined;
	readonly enabled: IObservable<boolean>;
	readonly reopenableCanvases: IObservable<readonly ICanvasReopenTarget[]>;
	isOwnerPresentable(reference: ICanvasReference, reader?: IReader): boolean;
	reopenCanvas(reference: ICanvasReference): Promise<void>;
}

export function canvasOwnerKey(owner: ICanvasOwner): string {
	return `${owner.providerId}\u0000${owner.session.toString()}\u0000${owner.chat.toString()}`;
}

export function getCanvasReferenceKey(reference: ICanvasReference): string {
	return `${canvasOwnerKey(reference)}\u0000${reference.canvas.toString()}`;
}

export function isCanvasOwner(first: ICanvasOwner, second: ICanvasOwner): boolean {
	return first.providerId === second.providerId && isEqual(first.session, second.session) && isEqual(first.chat, second.chat);
}

function createInputResource(reference: ICanvasReference): URI {
	return URI.from({
		scheme: 'session-canvas',
		path: '/canvas',
		query: encodeURIComponent(JSON.stringify({
			providerId: reference.providerId,
			session: reference.session.toString(),
			chat: reference.chat.toString(),
			canvas: reference.canvas.toString(),
		})),
	});
}

export class CanvasInput extends EditorInput {

	static readonly ID = 'sessions.editorInput.canvas';
	static readonly EDITOR_ID = 'sessions.editor.canvas';

	readonly resource: URI;
	readonly canvas = observableValue<ICanvas | undefined>(this, undefined);

	constructor(
		readonly reference: ICanvasReference,
		canvas: ICanvas,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
	) {
		super();
		this.resource = createInputResource(reference);
		this.canvas.set(canvas, undefined);
	}

	override get typeId(): string { return CanvasInput.ID; }
	override get editorId(): string { return CanvasInput.EDITOR_ID; }
	override get capabilities(): EditorInputCapabilities { return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton | EditorInputCapabilities.ForceReveal; }
	override getName(): string { return this.canvas.get()?.title ?? localize('canvas.editorName', "Canvas"); }
	override getDescription(): string { return localize('canvas.editorDescription', "Closing this tab hides the canvas. Reopen it from Add Tab in the Agents Window or ask the agent to open it again."); }
	override getIcon(): ThemeIcon { return Codicon.preview; }
	override getTitle(_verbosity?: Verbosity): string { return this.getName(); }
	override canReopen(): boolean { return false; }

	override canMove(_sourceGroup: GroupIdentifier, targetGroup: GroupIdentifier): true | string {
		return this.editorGroupsService.getGroup(targetGroup)?.windowId === this.editorGroupsService.mainPart.windowId
			? true
			: localize('canvas.mainWindowOnly', "Canvases can only be shown in the main window beside their owning conversation.");
	}

	setCanvas(canvas: ICanvas): void {
		const previous = this.canvas.get();
		this.canvas.set(canvas, undefined);
		if (previous?.title !== canvas.title) {
			this._onDidChangeLabel.fire();
		}
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return other instanceof CanvasInput ? isEqual(this.resource, other.resource) : super.matches(other);
	}
}
