import styles from './ParametersPanel.module.css';
import { EmptyState } from '../ui/EmptyState';
import type { ParameterModel } from '../../types';
import type { Language } from './types';
import { translator } from './types';

interface ParametersPanelProps {
  busy: boolean;
  collapsed: boolean;
  hasParameterModels: boolean;
  issue?: string;
  language: Language;
  model?: ParameterModel;
  onCommit: (parameterId: string) => void;
  onToggle: () => void;
  onValueChange: (parameterId: string, value: number) => void;
  rebuilding: boolean;
  values: Record<string, number>;
}

export function ParametersPanel({
  busy,
  collapsed,
  hasParameterModels,
  issue,
  language,
  model,
  onCommit,
  onToggle,
  onValueChange,
  rebuilding,
  values,
}: ParametersPanelProps) {
  const text = translator(language);
  return (
    <aside
      aria-label={text('Model parameters', '模型参数')}
      className={`${styles.rightPanel} ${collapsed ? styles.collapsedPanel : ''}`}
    >
      <header className={styles.panelHeader}>
        <div className={styles.panelTitle}>
          <button
            aria-expanded={!collapsed}
            aria-label={text('Toggle parameter panel', '切换参数面板')}
            className={styles.panelCollapseButton}
            onClick={onToggle}
            type="button"
          >
            {collapsed ? '‹' : '›'}
          </button>
          <div>
            <strong>{text('Parameters', '参数')}</strong>
            <small>
              {rebuilding
                ? text('Rebuilding complete model…', '正在重建完整模型…')
                : model
                  ? model.modelId
                  : text('Complete model controls', '完整模型控制')}
            </small>
          </div>
        </div>
      </header>
      {collapsed ? null : (
        <div className={styles.parameterScroll}>
          {issue ? <div className={styles.parameterIssue}>{issue}</div> : null}
          {model?.buildStatus === 'failed' ? <div className={styles.parameterIssue}>{text('The latest build did not pass. Current design values are shown; edit a parameter and try again.', '最近一次构建未通过。下方显示的是设计当前值；修改参数后可以再次尝试。')}</div> : null}
          {model?.previewStale && model.buildStatus !== 'failed' ? <div className={styles.parameterIssue}>{text('The displayed model is from an earlier build. Current design values are shown; rebuild to refresh geometry.', '当前显示模型来自较早的构建。下方显示的是设计当前值；重新构建后几何会更新。')}</div> : null}
          {!model ? (
            <EmptyState
              className={styles.emptyState}
              description={
                hasParameterModels
                  ? text(
                      'Select the display STEP or its STL/3MF print root to adjust the complete model.',
                      '请选择展示 STEP 或对应的 STL/3MF 打印根文件，才能调整完整模型。',
                    )
                  : text(
                      'Adjustable model parameters will appear here when the project declares them.',
                      '项目声明可调模型参数后，它们会显示在这里。',
                    )
              }
              title={
                hasParameterModels
                  ? text('Open the complete model.', '请打开完整模型。')
                  : text('No adjustable parameters yet.', '暂时没有可调参数。')
              }
            />
          ) : model.parameterError ? (
            <div className={styles.parameterIssue}>{model.parameterError}</div>
          ) : model.parameters.length === 0 ? (
            <EmptyState
              className={styles.emptyState}
              description={text(
                'This design has no directly adjustable numeric parameters.',
                '这个设计没有可直接调整的数值参数。',
              )}
              title={text('No declared parameters.', '没有已声明的参数。')}
            />
          ) : (
            <fieldset className={styles.parameterGroup} disabled={busy || !model.editable}>
              {model.parameters.map((parameter) => {
                const value = values[parameter.id] ?? parameter.value;
                const unit = parameter.unit ? ` ${parameter.unit}` : '';
                return (
                  <div className={styles.parameterField} key={parameter.id}>
                    <label htmlFor={`parameter-${parameter.id}`}>
                      {parameter.id}
                    </label>
                    <div className={styles.parameterValueRow}>
                      <input
                        id={`parameter-${parameter.id}`}
                        max={parameter.maximum}
                        min={parameter.minimum}
                        onBlur={() => onCommit(parameter.id)}
                        onChange={(event) => {
                          const next = event.currentTarget.valueAsNumber;
                          if (Number.isFinite(next)) {
                            onValueChange(parameter.id, next);
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.currentTarget.blur();
                          }
                        }}
                        step={parameter.step}
                        type="number"
                        value={value}
                      />
                      {parameter.unit ? <span>{parameter.unit}</span> : null}
                    </div>
                    {parameter.minimum !== undefined && parameter.maximum !== undefined ? (
                      <div className={styles.parameterRange}>
                        <input
                          aria-label={parameter.id}
                          max={parameter.maximum}
                          min={parameter.minimum}
                          onChange={(event) =>
                            onValueChange(
                              parameter.id,
                              event.currentTarget.valueAsNumber,
                            )
                          }
                          onKeyUp={() => onCommit(parameter.id)}
                          onPointerUp={() => onCommit(parameter.id)}
                          step={parameter.step}
                          type="range"
                          value={value}
                        />
                        <small className={styles.parameterLimits}>
                          <span>
                            <b>MIN</b> {parameter.minimum}
                            {unit}
                          </span>
                          <span>
                            <b>MAX</b> {parameter.maximum}
                            {unit}
                          </span>
                        </small>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </fieldset>
          )}
        </div>
      )}
    </aside>
  );
}
