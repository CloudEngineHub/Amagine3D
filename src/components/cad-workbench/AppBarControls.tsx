import type { RefObject } from 'react';

import styles from './AppBarControls.module.css';
import type { SessionSummary } from '../../types';
import type { Language } from './types';
import { translator } from './types';
import { ToolbarIcon } from './WorkbenchPrimitives';

interface AppBarControlsProps {
  busy: boolean;
  connectionStatus: string | undefined;
  language: Language;
  menuOpen: boolean;
  onNewProject: () => void;
  onOpenSession: (session: SessionSummary) => void;
  onToggleMenu: () => void;
  running: boolean;
  sessionId: string;
  sessionLoading: boolean;
  sessionMenuRef: RefObject<HTMLDivElement | null>;
  sessionTitle: (session: SessionSummary) => string;
  sessions: SessionSummary[];
  workspaceName: string;
}

export function AppBarControls({
  busy,
  connectionStatus,
  language,
  menuOpen,
  onNewProject,
  onOpenSession,
  onToggleMenu,
  running,
  sessionId,
  sessionLoading,
  sessionMenuRef,
  sessionTitle,
  sessions,
  workspaceName,
}: AppBarControlsProps) {
  const text = translator(language);
  const dateFormatter = new Intl.DateTimeFormat(
    language === 'zh' ? 'zh-CN' : 'en',
    { month: 'short', day: 'numeric' },
  );
  const status = sessionLoading
    ? text('Loading session…', '正在载入会话…')
    : connectionStatus;
  const disabled = running || busy || sessionLoading;
  return (
    <div className={styles.controls}>
      <span aria-hidden="true" className={styles.projectMark}>
        <ToolbarIcon name="chat" />
      </span>
      <div className={styles.titleSelect} ref={sessionMenuRef}>
        <button
          aria-expanded={menuOpen}
          aria-haspopup="listbox"
          className={styles.panelTitleButton}
          disabled={disabled}
          onClick={onToggleMenu}
          type="button"
        >
          <strong>{workspaceName}</strong>
          <span
            aria-hidden="true"
            className={styles.panelTitleChevron}
            data-open={menuOpen}
          >
            <svg fill="none" focusable="false" viewBox="0 0 16 16">
              <path d="m5.25 6.25 2.75-2 2.75 2M5.25 9.75l2.75 2 2.75-2" />
            </svg>
          </span>
        </button>
        {menuOpen ? (
          <div
            aria-label={text('Sessions', '会话')}
            className={styles.executionMenu}
            role="listbox"
          >
            <div className={styles.executionMenuHeading}>
              <strong>{text('Sessions', '会话')}</strong>
              <span>{sessions.length}</span>
            </div>
            {sessions.map((session) => (
              <button
                aria-selected={session.id === sessionId}
                className={styles.executionMenuItem}
                key={session.id}
                onClick={() => onOpenSession(session)}
                role="option"
                type="button"
              >
                <span>
                  {sessionTitle(session)}
                  {session.kind === 'builtin' ? (
                    <small className={styles.bundledProjectBadge}>
                      {text('Built-in', '内置')}
                    </small>
                  ) : null}
                </span>
                <time dateTime={session.updatedAt}>
                  {dateFormatter.format(Date.parse(session.updatedAt))}
                </time>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <button
        aria-label={text('New session', '新会话')}
        className={styles.newProjectButton}
        disabled={disabled}
        onClick={onNewProject}
        title={text('New session', '新会话')}
        type="button"
      >
        <ToolbarIcon name="new-run" />
        <span>{text('New session', '新会话')}</span>
      </button>
      <button
        aria-disabled="true"
        aria-label={text(
          'Runtime: Codex. This is currently the only available option.',
          '运行时：Codex。当前仅支持此选项。',
        )}
        className={styles.runtimeSelector}
        title={text(
          'Runtime · Codex (only option)',
          '运行时 · Codex（当前唯一选项）',
        )}
        type="button"
      >
        <ToolbarIcon name="runtime" />
        <span>Codex</span>
        <span
          aria-hidden="true"
          className={styles.runtimeSelectorChevron}
        >
          ⌄
        </span>
      </button>
      {status ? <small className={styles.status}>{status}</small> : null}
    </div>
  );
}
