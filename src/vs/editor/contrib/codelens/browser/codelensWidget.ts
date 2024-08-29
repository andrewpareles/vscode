/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from 'vs/base/browser/dom';
import { renderLabelWithIcons } from 'vs/base/browser/ui/iconLabel/iconLabels';
import { Constants } from 'vs/base/common/uint';
import 'vs/css!./codelensWidget';
import { ContentWidgetPositionPreference, IActiveCodeEditor, IContentWidget, IContentWidgetPosition, IViewZone, IViewZoneChangeAccessor } from 'vs/editor/browser/editorBrowser';
import { Range } from 'vs/editor/common/core/range';
import { IModelDecorationsChangeAccessor, IModelDeltaDecoration, ITextModel } from 'vs/editor/common/model';
import { ModelDecorationOptions } from 'vs/editor/common/model/textModel';
import { CodeLens, Command } from 'vs/editor/common/languages';
import { CodeLensItem } from 'vs/editor/contrib/codelens/browser/codelens';

class CodeLensViewZone implements IViewZone {

	readonly suppressMouseDown: boolean;
	readonly domNode: HTMLElement;

	afterLineNumber: number;
	/**
	 * We want that this view zone, which reserves space for a code lens appears
	 * as close as possible to the next line, so we use a very large value here.
	 */
	readonly afterColumn = Constants.MAX_SAFE_SMALL_INTEGER;
	heightInPx: number;

	private _lastHeight?: number;
	private readonly _onHeight: () => void;

	constructor(afterLineNumber: number, heightInPx: number, onHeight: () => void) {
		this.afterLineNumber = afterLineNumber;
		this.heightInPx = heightInPx;

		this._onHeight = onHeight;
		this.suppressMouseDown = true;
		this.domNode = document.createElement('div');
	}

	onComputedHeight(height: number): void {
		if (this._lastHeight === undefined) {
			this._lastHeight = height;
		} else if (this._lastHeight !== height) {
			this._lastHeight = height;
			this._onHeight();
		}
	}

	isVisible(): boolean {
		return this._lastHeight !== 0
			&& this.domNode.hasAttribute('monaco-visible-view-zone');
	}
}

class CodeLensContentWidget implements IContentWidget {

	private static _idPool: number = 0;

	// Editor.IContentWidget.allowEditorOverflow
	readonly allowEditorOverflow: boolean = false;
	readonly suppressMouseDown: boolean = true;

	private readonly _id: string;
	private readonly _domNode: HTMLElement;
	private readonly _editor: IActiveCodeEditor;
	private readonly _commandOfId = new Map<string, Command>();

	private _widgetPosition?: IContentWidgetPosition;
	private _isEmpty: boolean = true;

	constructor(
		editor: IActiveCodeEditor,
		line: number,
	) {
		this._editor = editor;
		this._id = `codelens.widget-${(CodeLensContentWidget._idPool++)}`;

		this.updatePosition(line);

		this._domNode = document.createElement('div');
		this._domNode.className = `codelens-decoration`;
	}

	renderTheCommands(lenses: Array<CodeLens | undefined | null>, animate: boolean): void {
		this._commandOfId.clear();

		const children: HTMLElement[] = [];
		let hasSymbol = false;
		for (let i = 0; i < lenses.length; i++) {
			const lens = lenses[i];
			if (!lens) {
				continue;
			}
			hasSymbol = true;
			if (lens.command) {
				const stringsAndIcons = renderLabelWithIcons(lens.command.title.trim());
				const id = lens.command.id ? `c${(CodeLensContentWidget._idPool++)}` : undefined;

				if (id)
					this._commandOfId.set(id, lens.command)

				if (id)
					children.push(dom.$('a', { id, title: lens.command.tooltip, role: 'button' }, ...stringsAndIcons))
				else
					children.push(dom.$('span', { title: lens.command.tooltip }, ...stringsAndIcons))

				const container = document.createElement('div');

				const input = document.createElement('input');
				const submit = dom.$('button', { type: 'button' }, 'Submit');
				container.appendChild(input);
				container.appendChild(submit);

				children.push(container)

				// add a delimiter
				if (i + 1 < lenses.length) {
					children.push(dom.$('span', undefined, '\u00a0|\u00a0'));
				}
			}
		}

		if (!hasSymbol) {
			// symbols but no commands
			dom.reset(this._domNode, dom.$('span', undefined, 'no commands'));

		} else {
			// symbols and commands
			dom.reset(this._domNode, ...children);
			if (this._isEmpty && animate) {
				this._domNode.classList.add('fadein');
			}
			this._isEmpty = false;
		}
	}

	commandOfHTMLa(link: HTMLLinkElement): Command | undefined {
		return link.parentElement === this._domNode
			? this._commandOfId.get(link.id)
			: undefined;
	}

	getId(): string {
		return this._id;
	}

	getDomNode(): HTMLElement {
		return this._domNode;
	}

	updatePosition(line: number): void {
		const column = this._editor.getModel().getLineFirstNonWhitespaceColumn(line);
		this._widgetPosition = {
			position: { lineNumber: line, column: column },
			preference: [ContentWidgetPositionPreference.ABOVE]
		};
	}

	getPosition(): IContentWidgetPosition | null {
		return this._widgetPosition || null;
	}
}

export interface IDecorationIdCallback {
	(decorationId: string): void;
}

// add/remove decoration (as deltas) and commit them
export class CodeLensHelper {

	private readonly _removeDecorations: string[];
	private readonly _addDecorations: IModelDeltaDecoration[];
	private readonly _addDecorationsCallbacks: IDecorationIdCallback[];

	constructor() {
		this._removeDecorations = [];
		this._addDecorations = [];
		this._addDecorationsCallbacks = [];
	}

	addDecoration(decoration: IModelDeltaDecoration, callback: IDecorationIdCallback): void {
		this._addDecorations.push(decoration);
		this._addDecorationsCallbacks.push(callback);
	}

	removeDecoration(decorationId: string): void {
		this._removeDecorations.push(decorationId);
	}

	commit(changeAccessor: IModelDecorationsChangeAccessor): void {
		const resultingDecorations = changeAccessor.deltaDecorations(this._removeDecorations, this._addDecorations);
		for (let i = 0, len = resultingDecorations.length; i < len; i++) {
			this._addDecorationsCallbacks[i](resultingDecorations[i]);
		}
	}
}

const codeLensDecorationOptions = ModelDecorationOptions.register({
	collapseOnReplaceEdit: true,
	description: 'codelens'
});

export class CodeLensWidget {

	private readonly _editor: IActiveCodeEditor;
	private readonly _viewZone: CodeLensViewZone;
	private readonly _viewZoneId: string;

	private _contentWidget?: CodeLensContentWidget;
	private _decorationIds: string[];
	private _data: CodeLensItem[];
	private _isDisposed: boolean = false;

	private _createOrLayoutWidget(): void {
		if (!this._contentWidget) {
			this._contentWidget = new CodeLensContentWidget(this._editor, this._viewZone.afterLineNumber + 1);
			this._editor.addContentWidget(this._contentWidget);
		} else {
			this._editor.layoutContentWidget(this._contentWidget);
		}
	}

	constructor(
		data: CodeLensItem[],
		editor: IActiveCodeEditor,
		helper: CodeLensHelper,
		viewZoneChangeAccessor: IViewZoneChangeAccessor,
		heightInPx: number,
		updateCallback: () => void
	) {
		this._editor = editor;
		this._data = data;

		// create combined range, track all ranges with decorations,
		// check if there is already something to render
		this._decorationIds = [];
		let range: Range | undefined;
		const lenses: CodeLens[] = [];

		this._data.forEach((codeLensData, i) => {

			if (codeLensData.symbol.command) {
				lenses.push(codeLensData.symbol);
			}

			helper.addDecoration({
				range: codeLensData.symbol.range,
				options: codeLensDecorationOptions
			}, id => this._decorationIds[i] = id);

			// the range contains all lenses on this line
			if (!range) {
				range = Range.lift(codeLensData.symbol.range);
			} else {
				range = Range.plusRange(range, codeLensData.symbol.range);
			}
		});

		this._viewZone = new CodeLensViewZone(range!.startLineNumber - 1, heightInPx, updateCallback);
		this._viewZoneId = viewZoneChangeAccessor.addZone(this._viewZone);

		if (lenses.length !== 0) {
			this._createOrLayoutWidget();
			this._contentWidget!.renderTheCommands(lenses, false);
		}
	}


	dispose(helper: CodeLensHelper, viewZoneChangeAccessor?: IViewZoneChangeAccessor): void {
		this._decorationIds.forEach(helper.removeDecoration, helper);
		this._decorationIds = [];
		viewZoneChangeAccessor?.removeZone(this._viewZoneId);
		if (this._contentWidget) {
			this._editor.removeContentWidget(this._contentWidget);
			this._contentWidget = undefined;
		}
		this._isDisposed = true;
	}

	isDisposed(): boolean {
		return this._isDisposed;
	}

	hasValidRange(): boolean {
		return this._decorationIds.some((id, i) => {
			const range = this._editor.getModel().getDecorationRange(id);
			const symbol = this._data[i].symbol;
			return !!(range && Range.isEmpty(symbol.range) === range.isEmpty());
		});
	}

	updateCodeLensSymbols(data: CodeLensItem[], helper: CodeLensHelper): void {
		this._decorationIds.forEach(helper.removeDecoration, helper);
		this._decorationIds = [];
		this._data = data;
		this._data.forEach((codeLensData, i) => {
			helper.addDecoration({
				range: codeLensData.symbol.range,
				options: codeLensDecorationOptions
			}, id => this._decorationIds[i] = id);
		});
	}

	updateHeight(height: number, viewZoneChangeAccessor: IViewZoneChangeAccessor): void {
		this._viewZone.heightInPx = height;
		viewZoneChangeAccessor.layoutZone(this._viewZoneId);
		if (this._contentWidget) {
			this._editor.layoutContentWidget(this._contentWidget);
		}
	}

	visibleCodeLenses(model: ITextModel): CodeLensItem[] | null {
		if (!this._viewZone.isVisible()) {
			return null;
		}

		// Read editor current state
		for (let i = 0; i < this._decorationIds.length; i++) {
			const range = model.getDecorationRange(this._decorationIds[i]);
			if (range) {
				this._data[i].symbol.range = range;
			}
		}
		return this._data;
	}

	updateCommands(lenses: Array<CodeLens | undefined | null>): void {

		this._createOrLayoutWidget();
		this._contentWidget!.renderTheCommands(lenses, true);

		for (let i = 0; i < this._data.length; i++) {
			const resolved = lenses[i];
			if (resolved) {
				const { symbol } = this._data[i];
				symbol.command = resolved.command || symbol.command;
			}
		}
	}

	commandOfHTMLa(link: HTMLLinkElement): Command | undefined {
		return this._contentWidget?.commandOfHTMLa(link);
	}

	getLineNumber(): number {
		const range = this._editor.getModel().getDecorationRange(this._decorationIds[0]);
		if (range) {
			return range.startLineNumber;
		}
		return -1;
	}

	update(viewZoneChangeAccessor: IViewZoneChangeAccessor): void {
		if (this.hasValidRange()) {
			const range = this._editor.getModel().getDecorationRange(this._decorationIds[0]);
			if (range) {
				this._viewZone.afterLineNumber = range.startLineNumber - 1;
				viewZoneChangeAccessor.layoutZone(this._viewZoneId);

				if (this._contentWidget) {
					this._contentWidget.updatePosition(range.startLineNumber);
					this._editor.layoutContentWidget(this._contentWidget);
				}
			}
		}
	}

	getItems(): CodeLensItem[] {
		return this._data;
	}
}
