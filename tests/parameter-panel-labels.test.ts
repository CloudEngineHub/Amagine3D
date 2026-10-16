import { strict as assert } from 'node:assert';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { test } from 'node:test';
import { createServer } from 'vite';

import type { ParameterModel } from '../src/types.ts';

test('ParametersPanel renders bilingual parameter names consistently for visible and accessible labels', async () => {
  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  });
  try {
    const { ParametersPanel } = await vite.ssrLoadModule('/src/components/cad-workbench/ParametersPanel.tsx');
    const model: ParameterModel = {
      artifactPaths: ['model.step'],
      displayPreviewPath: 'model.step',
      modelId: 'example',
      primaryPreviewPath: 'model.step',
      reportPath: '',
      designPath: 'model.a3d.json',
      revision: 'revision',
      editable: true,
      parameters: [{
        id: 'pilot_diameter',
        kind: 'number',
        value: 2.6,
        minimum: 2,
        maximum: 3,
        step: 0.01,
        label: { en: 'Pilot hole diameter', zh: '导孔直径' },
      }],
    };
    const render = (language: 'en' | 'zh', selected: ParameterModel = model) => renderToStaticMarkup(createElement(ParametersPanel, {
      busy: false,
      collapsed: false,
      hasParameterModels: true,
      language,
      model: selected,
      onCommit: () => undefined,
      onToggle: () => undefined,
      onValueChange: () => undefined,
      rebuilding: false,
      values: {},
    }));
    const english = render('en');
    assert.match(english, /aria-label="Pilot hole diameter"/u);
    assert.match(english, /for="parameter-pilot_diameter">Pilot hole diameter<\/label>/u);
    assert.match(english, /aria-label="Pilot hole diameter"[^>]*type="range"/u);
    assert.match(english, />Min<\/b>/u);
    assert.match(english, />Max<\/b>/u);

    const chinese = render('zh');
    assert.match(chinese, /aria-label="导孔直径"/u);
    assert.match(chinese, /for="parameter-pilot_diameter">导孔直径<\/label>/u);
    assert.match(chinese, /aria-label="导孔直径"[^>]*type="range"/u);
    assert.match(chinese, />最小<\/b>/u);
    assert.match(chinese, />最大<\/b>/u);

    const withoutLabel: ParameterModel = {
      ...model,
      parameters: [{ ...model.parameters[0]!, label: undefined }],
    };
    const legacy = render('zh', withoutLabel);
    assert.match(legacy, /for="parameter-pilot_diameter">pilot_diameter<\/label>/u);
  } finally {
    await vite.close();
  }
});
