import {
  lazy,
  Suspense,
  useLayoutEffect,
  useState,
} from 'react';

import styles from './PreviewPanel.module.css';
import type { ArtifactSummary } from '../../types';
import type { Language } from './types';
import { translator } from './types';
import { LoadingSpinner } from './WorkbenchPrimitives';
import type { ViewerStatus } from '../CadViewer';

const CadViewer = lazy(() =>
  import('../CadViewer').then((module) => ({ default: module.CadViewer })),
);

interface PreviewPanelProps {
  availablePreview?: ArtifactSummary;
  onShowLatest: () => void;
  cadArtifact?: ArtifactSummary;
  language: Language;
  onTogglePrintPreview: () => void;
  previewArtifact: ArtifactSummary | undefined;
  printPreview: boolean;
  printPreviewAvailable: boolean;
  running: boolean;
  runtimeReady: boolean;
  selectedArtifact: ArtifactSummary | undefined;
  selectedText: string | undefined;
}

export function PreviewPanel({
  availablePreview,
  onShowLatest,
  cadArtifact,
  language,
  onTogglePrintPreview,
  previewArtifact,
  printPreview,
  printPreviewAvailable,
  running,
  runtimeReady,
  selectedArtifact,
  selectedText,
}: PreviewPanelProps) {
  const text = translator(language);
  const [viewerStatus, setViewerStatus] = useState<ViewerStatus>({
    state: 'empty',
    text: 'Waiting for model data',
  });
  const [hideReferences, setHideReferences] = useState(false);
  useLayoutEffect(() => {
    setHideReferences(false);
  }, [previewArtifact]);
  const headingArtifact =
    selectedArtifact?.kind === 'image' || selectedText !== undefined
      ? selectedArtifact
      : previewArtifact;
  const assemblyPreview = selectedArtifact?.kind !== 'image'
    && selectedText === undefined && previewArtifact?.format === 'step' && !previewArtifact.partId;
  const referenceInfo = viewerStatus.referenceComponents;
  const canHideReferences = assemblyPreview && viewerStatus.state === 'ready'
    && (referenceInfo?.referenceMeshes ?? 0) > 0;
  const referenceTitle = canHideReferences
    ? (referenceInfo?.unclassifiedMeshes ?? 0) > 0
      ? text(
        'Hide labeled reference components; unlabeled geometry stays visible.',
        '隐藏已标记的参考元件；未分类的几何仍会显示。',
      )
      : text(
        'Hide reference components while keeping the assembly position and camera.',
        '隐藏参考元件，保留装配位置与当前视角。',
      )
    : text(
      'This model has no labeled reference components to hide.',
      '此模型没有可单独隐藏的已标记参考元件。',
    );
  return (
    <section className={styles.centerPanel} aria-label={text('Model preview', '模型预览')}>
      <header className={styles.canvasToolbar}>
        <div className={styles.canvasHeading}>
          <div className={styles.canvasHeadingCopy}>
            <h2>{headingArtifact?.partId ? text(`Part · ${headingArtifact.partId}`, `子部件 · ${headingArtifact.partId}`)
              : assemblyPreview ? text('Assembly preview', '整机预览') : headingArtifact?.name ?? text('Model preview', '模型预览')}</h2>
            {availablePreview ? <span role="status"><button className={styles.latestPreview} type="button" onClick={onShowLatest}>
              {availablePreview.status === 'draft' ? text('New draft available · view', '新草稿已就绪 · 查看') : text('Latest preview available · view', '最新预览已就绪 · 查看')}
            </button></span> : null}
          </div>
        </div>
        <div className={styles.canvasMeta}>
          {selectedArtifact?.kind !== 'image' && selectedText === undefined ? (
            <span
              className={styles.viewerSummary}
              data-status={viewerStatus.state}
            >
              <span aria-hidden="true" className={styles.statusMark} />
              <span>{viewerStatus.text}</span>
            </span>
          ) : null}
          <span
            aria-live="polite"
            className={styles.phase}
            data-state={running ? 'running' : runtimeReady ? 'ready' : 'offline'}
          >
            {running ? 'RUNNING' : runtimeReady ? 'READY' : 'OFFLINE'}
          </span>
          {assemblyPreview ? (
            <button
              aria-checked={canHideReferences && hideReferences}
              aria-label={text('Hide reference components', '隐藏参考元件')}
              className={styles.previewSwitch}
              disabled={!canHideReferences}
              onClick={() => setHideReferences((hidden) => !hidden)}
              role="switch"
              title={referenceTitle}
              type="button"
            >
              <span>{text('Hide reference components', '隐藏参考元件')}</span>
              <span aria-hidden="true" className={styles.switchTrack}><span /></span>
            </button>
          ) : null}
          <button
            aria-checked={printPreview}
            aria-label={text('Toggle print layout', '切换打印排盘')}
            className={styles.previewSwitch}
            disabled={!printPreviewAvailable}
            onClick={onTogglePrintPreview}
            role="switch"
            title={text(
              'Show the separate 3MF or STL print layout',
              '查看单独的 3MF 或 STL 打印排盘文件',
            )}
            type="button"
          >
            <span>{text('Print layout', '打印排盘')}</span>
            <span aria-hidden="true" className={styles.switchTrack}>
              <span />
            </span>
          </button>
        </div>
      </header>

      <div className={styles.canvasBody}>
        {selectedArtifact?.kind === 'image' ? (
          <div className={styles.emptyCanvas}>
            <img
              alt={selectedArtifact.name}
              src={selectedArtifact.url}
              style={{ maxHeight: '100%', maxWidth: '100%', objectFit: 'contain' }}
            />
          </div>
        ) : selectedText !== undefined ? (
          <pre className={styles.codePreview} tabIndex={0}>
            <code>{selectedText}</code>
          </pre>
        ) : !previewArtifact && (selectedArtifact?.purpose === 'cad-model' || cadArtifact) ? (
          <div className={styles.emptyCanvas}>
            <span>{text('CAD file available. Preview is not ready.', 'CAD 文件已保留，预览尚未就绪。')}</span>
            <a href={(selectedArtifact?.purpose === 'cad-model' ? selectedArtifact : cadArtifact)!.url}
              download={(selectedArtifact?.purpose === 'cad-model' ? selectedArtifact : cadArtifact)!.name}>{text('Download STEP', '下载 STEP')}</a>
          </div>
        ) : (
          <Suspense
            fallback={
              <div className={styles.emptyCanvas}>
                <LoadingSpinner />
                <span>{text('Loading viewer…', '正在载入查看器…')}</span>
              </div>
            }
          >
            <CadViewer
              artifact={previewArtifact}
              hideReferenceComponents={hideReferences}
              onStatusChange={setViewerStatus}
            />
          </Suspense>
        )}
      </div>

    </section>
  );
}
