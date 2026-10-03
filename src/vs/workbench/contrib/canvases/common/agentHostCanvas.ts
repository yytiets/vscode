/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { derived, IObservable, mapObservableArrayCached } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IAgentConnection } from '../../../../platform/agentHost/common/agentService.js';
import { observableFromSubscription } from '../../../../platform/agentHost/common/state/agentSubscription.js';
import { CanvasReference, CanvasState } from '../../../../platform/agentHost/common/state/protocol/channels-canvas/state.js';
import { StateComponents } from '../../../../platform/agentHost/common/state/sessionState.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ICanvas, ICanvasContext, ICanvasOwner } from './canvas.js';

export class AgentHostCanvas implements ICanvas {
	readonly resource: URI;
	readonly instanceId: string | undefined;
	readonly title: string;
	readonly status: string | undefined;
	readonly source: URI | undefined;

	constructor(
		resource: URI,
		canvas: CanvasState | undefined,
		@ILogService logService: ILogService,
	) {
		this.resource = resource;
		this.instanceId = canvas?.instanceId;
		this.title = canvas?.title ?? canvas?.extensionName ?? canvas?.canvasId ?? localize('canvas.pendingTitle', "Canvas");
		this.status = canvas?.status;
		if (canvas?.url !== undefined) {
			try {
				const source = URI.parse(canvas.url, true);
				if ((source.scheme === Schemas.http || source.scheme === Schemas.https) && source.authority) {
					this.source = source;
				} else {
					logService.warn('[AgentHostCanvas] Unsupported canvas source');
				}
			} catch {
				logService.warn('[AgentHostCanvas] Invalid canvas source');
			}
		}
	}
}

export class AgentHostCanvasCollection extends Disposable {

	constructor(
		readonly providerId: string,
		private readonly connection: IAgentConnection,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	createContext(owner: ICanvasOwner, references: IObservable<readonly CanvasReference[] | undefined>): ICanvasContext {
		const states = mapObservableArrayCached(this, references.map(value => value ?? []), canvas => {
			const resource = URI.parse(canvas.resource, true);
			const subscription = derived(this, reader => {
				this.connection.initializeResult.read(reader);
				const reference = reader.store.add(this.connection.getSubscription(StateComponents.Canvas, resource, 'AgentHostCanvasCollection'));
				return observableFromSubscription(this, reference.object);
			});
			return derived(this, reader => {
				const state = subscription.read(reader).read(reader);
				return new AgentHostCanvas(resource, state && !(state instanceof Error) ? state : undefined, this.logService);
			});
		}, canvas => canvas.resource);
		return {
			owner,
			canvases: derived(this, reader => references.read(reader) === undefined ? undefined : states.read(reader).map(state => state.read(reader))),
		};
	}
}
