/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock, upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CanvasesEnabledSettingId } from '../../../../../platform/agentHost/common/agentService.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotification, INotificationHandle } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { IEditorIdentifier, ITextDiffEditorPane } from '../../../../common/editor.js';
import { IChatEntitlementService } from '../../../../services/chat/common/chatEntitlementService.js';
import { IEditorGroup, IEditorGroupsService, IEditorPart } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { CanvasInput, canvasOwnerKey, ICanvas, ICanvasContext, ICanvasContextService, ICanvasOwner } from '../../common/canvas.js';
import { CanvasService } from '../../electron-browser/canvasService.js';

suite('CanvasService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createHarness() {
		const owner: ICanvasOwner = { providerId: 'local', session: URI.parse('session:/owner'), chat: URI.parse('chat:/owner') };
		const canvas: ICanvas = {
			resource: URI.parse('canvas:/preview'), instanceId: 'preview', title: 'Preview', source: URI.parse('https://example.test'),
		};
		const canvases = observableValue<readonly ICanvas[] | undefined>('canvases', []);
		const contexts = observableValue<readonly ICanvasContext[]>('contexts', [{ owner, canvases }]);
		const visible = observableValue<ReadonlySet<string>>('visible', new Set([canvasOwnerKey(owner)]));
		const removed = store.add(new Emitter<ICanvasOwner>());
		const contextService = upcastPartial<ICanvasContextService>({
			contexts, onDidRemoveOwner: removed.event,
			isOwnerVisible: (owner, reader) => visible.read(reader).has(canvasOwnerKey(owner)),
			getEditorGroup: () => group,
		});
		const group = upcastPartial<IEditorGroup>({ id: 1, windowId: 1 });
		const opened: CanvasInput[] = [];
		const openEditors: IEditorIdentifier[] = [];
		const closed: CanvasInput[] = [];
		let pendingOpen: DeferredPromise<void> | undefined;
		let failOpen = false;
		const notifications: INotification[] = [];
		const notificationService = new class extends TestNotificationService {
			override notify(notification: INotification): INotificationHandle {
				notifications.push(notification);
				return super.notify(notification);
			}
		}();
		const editorService = new class extends mock<IEditorService>() {
			override async openEditor(...args: unknown[]): Promise<ITextDiffEditorPane | undefined> {
				const input = args[0];
				if (!(input instanceof CanvasInput)) {
					throw new Error('Expected a canvas input');
				}
				opened.push(input);
				if (pendingOpen) {
					await pendingOpen.p;
				}
				if (failOpen) {
					return undefined;
				}
				openEditors.push({ groupId: group.id, editor: input });
				return upcastPartial<ITextDiffEditorPane>({ group, input });
			}
			override findEditors(): readonly IEditorIdentifier[] {
				return openEditors.slice();
			}
			override async closeEditors(editors: readonly IEditorIdentifier[]): Promise<void> {
				for (const editor of editors) {
					if (editor.editor instanceof CanvasInput) {
						closed.push(editor.editor);
						openEditors.splice(openEditors.indexOf(editor), 1);
					}
				}
			}
		}();
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IEditorGroupsService, {
			mainPart: upcastPartial<IEditorPart>({ windowId: 1 }),
		});
		const sentiment = store.add(new Emitter<void>());
		let hidden = false;
		const entitlementService = upcastPartial<IChatEntitlementService>({
			get sentiment() { return { hidden }; },
			onDidChangeSentiment: sentiment.event,
		});
		const service = store.add(new CanvasService(contextService, editorService, instantiationService, entitlementService,
			new TestConfigurationService({ [CanvasesEnabledSettingId]: true }), new NullLogService(), notificationService));
		return {
			owner, canvas, canvases, contexts, visible, removed, opened, closed, notifications, service,
			delayOpen: () => pendingOpen = new DeferredPromise<void>(),
			failOpen: (value: boolean) => failOpen = value,
			hideAI: () => { hidden = true; sentiment.fire(); },
		};
	}

	test('deduplicates presentation, preserves dismissal, and reveals a new canvas lifetime', async () => {
		const harness = createHarness();
		harness.canvases.set([harness.canvas], undefined);
		await timeout(0);
		harness.canvases.set([{ ...harness.canvas, title: 'Renamed' }], undefined);
		harness.opened[0].dispose();
		harness.canvases.set([harness.canvas], undefined);
		const afterDismissal = harness.opened.length;
		harness.canvases.set([{ ...harness.canvas, resource: URI.parse('canvas:/new-lifetime') }], undefined);
		assert.deepStrictEqual({ afterDismissal, channels: harness.opened.map(input => input.reference.canvas.toString()) }, { afterDismissal: 1, channels: ['canvas:/preview', 'canvas:/new-lifetime'] });
	});

	test('keeps hidden owners out of presentation and isolates identical instances in different chats', async () => {
		const harness = createHarness();
		harness.visible.set(new Set(), undefined);
		harness.canvases.set([harness.canvas], undefined);
		const hiddenCount = harness.opened.length;
		const peerOwner = { ...harness.owner, chat: URI.parse('chat:/peer') };
		harness.contexts.set([{ owner: harness.owner, canvases: harness.canvases }, { owner: peerOwner, canvases: harness.canvases }], undefined);
		harness.visible.set(new Set([canvasOwnerKey(harness.owner), canvasOwnerKey(peerOwner)]), undefined);
		await timeout(0);
		assert.deepStrictEqual({
			hiddenCount, count: harness.opened.length, identitiesDistinct: harness.opened[0].resource.toString() !== harness.opened[1].resource.toString(),
		}, { hiddenCount: 0, count: 2, identitiesDistinct: true });
	});

	test('closes a late-opened editor after authoritative removal', async () => {
		const harness = createHarness();
		const pending = harness.delayOpen();
		harness.canvases.set([harness.canvas], undefined);
		harness.canvases.set([], undefined);
		await pending.complete();
		await timeout(0);
		assert.deepStrictEqual({ disposed: harness.opened[0].isDisposed(), closed: harness.closed.length }, { disposed: true, closed: 1 });
	});

	test('surfaces failed opens without permanently marking the lifetime presented', async () => {
		const harness = createHarness();
		harness.failOpen(true);
		harness.canvases.set([harness.canvas], undefined);
		await timeout(0);
		harness.failOpen(false);
		harness.visible.set(new Set(), undefined);
		harness.visible.set(new Set([canvasOwnerKey(harness.owner)]), undefined);
		await timeout(0);
		assert.deepStrictEqual({ attempted: harness.opened.length, notifications: harness.notifications.length, sameInput: harness.opened[0] === harness.opened[1] }, { attempted: 2, notifications: 1, sameInput: true });
	});

	test('does not report a cancelled open as a failure after its input was removed', async () => {
		const harness = createHarness();
		const pending = harness.delayOpen();
		harness.failOpen(true);
		harness.canvases.set([harness.canvas], undefined);
		harness.canvases.set([], undefined);
		await pending.complete();
		await timeout(0);
		assert.deepStrictEqual({ notifications: harness.notifications.length, disposed: harness.opened[0].isDisposed() }, { notifications: 0, disposed: true });
	});

	test('updates a source during an in-flight open without repeatedly revealing the lifetime', async () => {
		const harness = createHarness();
		const pending = harness.delayOpen();
		harness.canvases.set([harness.canvas], undefined);
		harness.canvases.set([{ ...harness.canvas, source: URI.parse('https://example.test/replacement') }], undefined);
		const beforeCompletion = harness.opened.length;
		await pending.complete();
		await timeout(0);
		assert.deepStrictEqual({ beforeCompletion, after: harness.opened.length, source: harness.opened[0].canvas.get()?.source?.toString() }, {
			beforeCompletion: 1, after: 1, source: 'https://example.test/replacement',
		});
	});

	test('AI hiding closes presentation and stops eligibility immediately', async () => {
		const harness = createHarness();
		harness.canvases.set([harness.canvas], undefined);
		await timeout(0);
		harness.hideAI();
		await timeout(0);
		assert.deepStrictEqual({
			enabled: harness.service.enabled.get(), presentable: harness.service.isOwnerPresentable(harness.opened[0].reference), closed: harness.closed.length,
		}, { enabled: false, presentable: false, closed: 1 });
	});
});
