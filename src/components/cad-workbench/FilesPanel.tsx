import { useEffect, useMemo, useState } from 'react';

import styles from './FilesPanel.module.css';
import { artifactDesigns } from '../../lib/artifact-groups';
import type { ArtifactSummary } from '../../types';
import { ArtifactFileList, DesignArtifactCard } from './DesignArtifactCard';
import type { Language } from './types';
import { translator } from './types';
import { LoadingSpinner, RefreshIcon } from './WorkbenchPrimitives';

export interface FilesPanelProps {
  artifacts: ArtifactSummary[];
  language: Language;
  loading: boolean;
  workspaceName: string;
  followLatest: boolean;
  onFollowLatest: () => void;
  onDownload: (artifacts: ArtifactSummary[]) => Promise<void>;
  onRefresh: () => void;
  onSelect: (artifact: ArtifactSummary) => void;
  selectionScope: string;
  selectedPath: string | undefined;
}

export function FilesPanel({ artifacts, language, loading, workspaceName, followLatest, onFollowLatest,
  onDownload, onRefresh, onSelect, selectionScope, selectedPath }: FilesPanelProps) {
  const text = translator(language);
  const [downloadError, setDownloadError] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const designs = useMemo(() => artifactDesigns(artifacts, workspaceName), [artifacts, workspaceName]);
  const selectedArtifacts = useMemo(() => artifacts.filter(({ path }) => selectedPaths.has(path)), [selectedPaths, artifacts]);

  useEffect(() => {
    const availablePaths = new Set(artifacts.map(({ path }) => path));
    setSelectedPaths((current) => {
      const next = new Set([...current].filter((path) => availablePaths.has(path)));
      return next.size === current.size ? current : next;
    });
  }, [artifacts]);

  useEffect(() => {
    setSelectedPaths(new Set());
    setDownloadError(false);
  }, [selectionScope]);

  function toggleSelected(path: string) {
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    setDownloadError(false);
  }

  async function download(files: ArtifactSummary[]) {
    if (!files.length || downloading) return;
    setDownloading(true);
    setDownloadError(false);
    try { await onDownload(files); }
    catch { setDownloadError(true); }
    finally { setDownloading(false); }
  }

  const fileListProps = { language, selectedPath, selectedPaths, onSelect, onToggle: toggleSelected };
  return (
    <div className={styles.fileWorkspace} role="tabpanel">
      <section className={styles.fileSection}>
        <div className={styles.sectionHeading}>
          <p className={styles.fileHint}>{text(`${designs.length} designs`, `${designs.length} 个设计成果`)}</p>
          <div className={styles.fileHeadingActions}>
            <button aria-label={text('Refresh files', '刷新文件')} className={styles.fileRefreshButton}
              disabled={loading} onClick={onRefresh} type="button">
              {loading ? <LoadingSpinner /> : <RefreshIcon />}
            </button>
          </div>
        </div>
        {designs.length > 0 ? (
          <div className={styles.followBar} aria-live="polite">
            <span>{followLatest ? text('Following the latest preview', '正在跟随最新预览') : text('Keeping your selected version', '正在查看所选版本')}</span>
            {!followLatest ? <button type="button" onClick={onFollowLatest}>{text('Follow latest', '跟随最新')}</button> : null}
          </div>
        ) : null}
        {designs.length === 0 ? (
          <p className={styles.fileEmpty}>{text('Your first draft will appear here as soon as it is ready.', '首个草稿生成后会立即显示在这里。')}</p>
        ) : (
          <div className={styles.designList}>
            {designs.map((design) => <DesignArtifactCard key={design.id} design={design} {...fileListProps}
              downloading={downloading} onDownload={(files) => void download(files)} />)}
          </div>
        )}
        {artifacts.length > 0 ? (
          <details className={styles.allFiles}>
            <summary>{text('All files', '全部文件')} <span>{artifacts.length}</span></summary>
            <p className={styles.fileHint}>{text('Includes source, reports and intermediate files.', '包含源文件、检查报告和中间产物。')}</p>
            <ArtifactFileList artifacts={artifacts} {...fileListProps} />
          </details>
        ) : null}
      </section>
      <footer className={styles.fileActions}>
        <span aria-live="polite">{downloadError ? text('Download failed. Please try again.', '下载失败，请重试。')
          : text(`${selectedArtifacts.length} files selected`, `已选择 ${selectedArtifacts.length} 个文件`)}</span>
        <button disabled={selectedArtifacts.length === 0 || downloading} onClick={() => void download(selectedArtifacts)} type="button">
          {downloading ? text('Preparing…', '正在准备…') : selectedArtifacts.length > 1 ? text('Download ZIP', '下载 ZIP') : text('Download', '下载')}
        </button>
      </footer>
    </div>
  );
}
