/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { constObservable, derived, IReader } from '../../../../base/common/observable.js';
import { isEqual } from '../../../../base/common/resources.js';
import { canvasOwnerKey, ICanvasContext, ICanvasContextService, ICanvasOwner, isCanvasOwner } from '../../../../workbench/contrib/canvases/common/canvas.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IChatService } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';

export class SessionCanvasContextService extends Disposable implements ICanvasContextService {

	declare readonly _serviceBrand: undefined;
	private readonly removedOwner = this._register(new Emitter<ICanvasOwner>());
	readonly onDidRemoveOwner = this.removedOwner.event;
	readonly contexts;
	private readonly knownOwners = new Map<string, ICanvasOwner>();

	constructor(
		@ISessionsService sessionsService: ISessionsService,
		@ISessionsManagementService sessionsManagementService: ISessionsManagementService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IChatService chatService: IChatService,
	) {
		super();
		this.contexts = derived<readonly ICanvasContext[]>(this, reader => {
			const session = sessionsService.activeSession.read(reader);
			const chat = session?.activeChat.read(reader);
			if (!session || !chat) {
				return [];
			}
			const owner: ICanvasOwner = { providerId: session.providerId, session: session.resource, chat: chat.resource };
			this.knownOwners.set(canvasOwnerKey(owner), owner);
			chatService.chatModels.read(reader);
			const openRequests = chatService.getSession(chat.resource)?.canvasContext?.read(reader)?.openRequests;
			return [{ owner, canvases: session.capabilities.read(reader).supportsCanvases ? chat.canvases ?? constObservable(undefined) : constObservable([]), openRequests }];
		});
		this._register(sessionsManagementService.onDidChangeSessions(event => {
			for (const session of event.removed) {
				for (const [key, owner] of this.knownOwners) {
					if (owner.providerId === session.providerId && isEqual(owner.session, session.resource)) {
						this.knownOwners.delete(key);
						this.removedOwner.fire(owner);
					}
				}
			}
		}));
	}

	isOwnerVisible(owner: ICanvasOwner, reader?: IReader): boolean {
		return this.contexts.read(reader).some(context => isCanvasOwner(context.owner, owner));
	}

	getEditorGroup(): IEditorGroup {
		return this.editorGroupsService.mainPart.activeGroup;
	}
}
