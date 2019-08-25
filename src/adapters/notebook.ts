import { JupyterLabWidgetAdapter } from './jupyterlab';
import { Notebook, NotebookPanel } from '@jupyterlab/notebook';
import { CodeMirror } from './codemirror';
import { VirtualEditorForNotebook } from '../virtual/editors/notebook';
import { ICompletionManager } from '@jupyterlab/completer';
import { NotebookJumper } from '@krassowski/jupyterlab_go_to_definition/lib/jumpers/notebook';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { JupyterFrontEnd } from '@jupyterlab/application';
import { until_ready } from '../utils';
import { LSPConnector } from '../completion';
import { CodeEditor } from '@jupyterlab/codeeditor';
import { IForeignCodeExtractorsRegistry } from '../extractors/types';
import { RegExpForeignCodeExtractor } from '../extractors/regexp';
import { language_specific_overrides } from '../magics/defaults';

// TODO: make the regex code extractors configurable

let foreign_code_extractors: IForeignCodeExtractorsRegistry = {
  // general note: to match new lines use [^] instead of dot, unless the target is ES2018, then use /s
  python: [
    // R magic will always be in the same, single R-namespace
    new RegExpForeignCodeExtractor({
      language: 'R',
      pattern: '%%R( [^]*)?\n([^]*)',
      extract_to_foreign: '$2',
      keep_in_host: true,
      is_standalone: false
    }),
    // most magics are standalone, i.e. consecutive code cells with the same magic create two different namespaces
    new RegExpForeignCodeExtractor({
      language: 'python',
      pattern: '%%python( [^]*)?\n(.*)',
      extract_to_foreign: '$2',
      keep_in_host: false,
      is_standalone: true
    }),
    new RegExpForeignCodeExtractor({
      language: 'python',
      pattern: '%%timeit( [^]*)?\n(.*)',
      extract_to_foreign: '$2',
      keep_in_host: false,
      is_standalone: true
    })
  ]
};

export class NotebookAdapter extends JupyterLabWidgetAdapter {
  editor: Notebook;
  widget: NotebookPanel;
  virtual_editor: VirtualEditorForNotebook;
  completion_manager: ICompletionManager;
  jumper: NotebookJumper; // TODO: make jumper optional?

  constructor(
    editor_widget: NotebookPanel,
    jumper: NotebookJumper,
    app: JupyterFrontEnd,
    completion_manager: ICompletionManager,
    rendermime_registry: IRenderMimeRegistry
  ) {
    super(app, rendermime_registry, 'completer:invoke-notebook');
    this.widget = editor_widget;
    this.editor = editor_widget.content;
    this.completion_manager = completion_manager;
    this.jumper = jumper;
    this.init_once_ready().then();
  }

  is_ready() {
    return (
      this.widget.context.isReady &&
      this.widget.content.isVisible &&
      this.widget.content.widgets.length > 0 &&
      this.language !== ''
    );
  }

  get document_path(): string {
    return this.widget.context.path;
  }

  get language(): string {
    let language_metadata = this.widget.model.metadata.get('language_info');
    // @ts-ignore
    return language_metadata.name;
  }

  find_ce_editor(cm_editor: CodeMirror.Editor): CodeEditor.IEditor {
    return this.virtual_editor.cm_editor_to_cell.get(cm_editor).editor;
  }

  async init_once_ready() {
    console.log('LSP: waiting for', this.document_path, 'to fully load');
    await until_ready(this.is_ready.bind(this), -1);
    console.log('LSP:', this.document_path, 'ready for connection');

    // TODO
    // this.widget.context.pathChanged

    this.virtual_editor = new VirtualEditorForNotebook(
      this.widget,
      this.language,
      language_specific_overrides,
      foreign_code_extractors
    );

    this.connect(this.virtual_editor.virtual_document);
    this.create_adapter();

    // refresh server held state after every change
    // note this may be changed soon: https://github.com/jupyterlab/jupyterlab/issues/5382#issuecomment-515643504
    this.widget.model.contentChanged.connect(
      this.refresh_lsp_notebook_image.bind(this)
    );

    // and refresh it after the cell was activated, just to make sure that the first experience is ok
    this.widget.content.activeCellChanged.connect(
      this.refresh_lsp_notebook_image.bind(this)
    );

    // register completion connectors on cells

    // see https://github.com/jupyterlab/jupyterlab/blob/c0e9eb94668832d1208ad3b00a9791ef181eca4c/packages/completer-extension/src/index.ts#L198-L213
    const cell = this.widget.content.activeCell;
    const connector = new LSPConnector({
      editor: cell.editor,
      connection: this.main_connection,
      coordinates_transform: (position: CodeMirror.Position) =>
        this.virtual_editor.transform_from_notebook(cell, position),
      session: this.widget.session
    });
    const handler = this.completion_manager.register({
      connector,
      editor: cell.editor,
      parent: this.widget
    });
    this.widget.content.activeCellChanged.connect((notebook, cell) => {
      const connector = new LSPConnector({
        editor: cell.editor,
        connection: this.main_connection,
        coordinates_transform: (position: CodeMirror.Position) =>
          this.virtual_editor.transform_from_notebook(cell, position),
        session: this.widget.session
      });

      handler.editor = cell.editor;
      handler.connector = connector;
    });
  }

  get_document_content() {
    return this.virtual_editor.getValue();
  }

  refresh_lsp_notebook_image(slot: any) {
    // TODO this is fired too often currently, debounce!
    this.main_connection.sendChange();
  }
}