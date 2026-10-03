/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../../../workbench/contrib/canvases/electron-browser/canvases.contribution.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ICanvasContextService, ICanvasService } from '../../../../workbench/contrib/canvases/common/canvas.js';
import { registerSessionCanvasAddTabActions } from './sessionCanvasActions.js';
import { SessionCanvasContextService } from './sessionCanvasService.js';

registerSingleton(ICanvasContextService, SessionCanvasContextService, InstantiationType.Delayed);

class SessionCanvasAddTabContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.contrib.canvasAddTab';

	constructor(@ICanvasService canvasService: ICanvasService) {
		super();
		this._register(registerSessionCanvasAddTabActions(canvasService));
	}
}

registerWorkbenchContribution2(SessionCanvasAddTabContribution.ID, SessionCanvasAddTabContribution, WorkbenchPhase.BlockRestore);
