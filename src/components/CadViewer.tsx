import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';

import styles from './CadViewer.module.css';
import { parseStepPreview, stepPreviewUrl } from '../lib/step-preview';
import { formatBytes } from '../lib/format';
import { referenceVisibility, type ReferenceComponentInfo } from '../lib/reference-visibility';
import { createViewerGrid } from '../lib/viewer-grid';
import type { ArtifactSummary } from '../types';

type ViewName = 'front' | 'isometric' | 'top';
export type ViewerState = 'empty' | 'error' | 'loading' | 'ready';

export interface ViewerStatus {
  state: ViewerState;
  text: string;
  referenceComponents?: ReferenceComponentInfo;
}

interface ViewerController {
  fit: () => void;
  setView: (view: ViewName) => void;
  setReferencesHidden: (hidden: boolean) => void;
}

interface CadViewerProps {
  artifact?: ArtifactSummary;
  hideReferenceComponents?: boolean;
  onStatusChange?: (status: ViewerStatus) => void;
  plateNavigation?: {
    label: string;
    positionLabel: string;
    previousLabel: string;
    nextLabel: string;
    onPrevious?: () => void;
    onNext?: () => void;
  };
}

function disposeMaterial(material: Material): void {
  for (const value of Object.values(material)) {
    if (value && typeof value === 'object' && 'dispose' in value) {
      const disposable = value as { dispose?: unknown };
      if (typeof disposable.dispose === 'function') disposable.dispose();
    }
  }
  material.dispose();
}

function disposeTree(root: Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material)
      ? object.material
      : [object.material];
    materials.forEach(disposeMaterial);
  });
}

function triangleCount(root: Object3D): number {
  let total = 0;
  root.traverseVisible((object) => {
    if (!(object instanceof Mesh)) return;
    const geometry = object.geometry as BufferGeometry;
    total += geometry.index
      ? geometry.index.count / 3
      : (geometry.attributes.position?.count ?? 0) / 3;
  });
  return Math.round(total);
}

function directionForView(view: ViewName): Vector3 {
  switch (view) {
    case 'front':
      return new Vector3(0, -1, 0);
    case 'top':
      return new Vector3(0, 0, 1);
    case 'isometric':
      return new Vector3(1, -1, 0.8).normalize();
  }
}

async function parseModel(
  artifact: ArtifactSummary,
  buffer: ArrayBuffer,
): Promise<Object3D> {
  if (artifact.format === 'stl') {
    const geometry = new STLLoader().parse(buffer);
    geometry.computeVertexNormals();
    return new Mesh(
      geometry,
      new MeshStandardMaterial({
        color: new Color('#9ba7b3'),
        metalness: 0.04,
        roughness: 0.68,
      }),
    );
  }
  if (artifact.format === 'step') {
    return parseStepPreview(JSON.parse(new TextDecoder().decode(buffer)), artifact.sha256);
  }
  if (artifact.format === '3mf') return new ThreeMFLoader().parse(buffer);
  throw new Error('Browser preview supports STEP, STL and 3MF.');
}

function ToolButton({
  children,
  disabled = false,
  label,
  onClick,
  pressed,
}: {
  children: ReactNode;
  disabled?: boolean;
  label?: string;
  onClick?: () => void;
  pressed?: boolean;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={pressed}
      className={styles.toolButton}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

function StatePanel({
  detail,
  title,
  tone,
}: {
  detail: string;
  title: string;
  tone: 'empty' | 'error' | 'loading';
}) {
  return (
    <div className={styles.statePanel} data-tone={tone}>
      {tone === 'loading' ? <span className={styles.spinner} /> : null}
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

export function CadViewer({
  artifact,
  hideReferenceComponents = false,
  onStatusChange,
  plateNavigation,
}: CadViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<ViewerController | undefined>(undefined);
  const [bounds, setBounds] = useState<Vector3>();
  const [error, setError] = useState('');
  const [state, setState] = useState<ViewerState>('empty');
  const [triangles, setTriangles] = useState(0);
  const [referenceComponents, setReferenceComponents] = useState<ReferenceComponentInfo>();
  const hideReferencesRef = useRef(hideReferenceComponents);

  const statusText =
    state === 'ready'
      ? `${triangles.toLocaleString()} triangles · ${artifact?.format === 'step' ? 'assembly preview' : 'print mesh'}`
      : state === 'loading'
        ? 'Reading model data…'
        : state === 'error'
          ? 'Model preview unavailable'
          : 'Waiting for model data';

  useEffect(() => {
    onStatusChange?.({ state, text: statusText, referenceComponents });
  }, [onStatusChange, referenceComponents, state, statusText]);

  useLayoutEffect(() => {
    hideReferencesRef.current = hideReferenceComponents;
    controllerRef.current?.setReferencesHidden(hideReferenceComponents);
  }, [hideReferenceComponents]);

  // Reset the persistent canvas and its status before a changed artifact can paint.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    setReferenceComponents(undefined);
    if (!canvas || !host || !artifact?.format) {
      controllerRef.current = undefined;
      setBounds(undefined);
      setTriangles(0);
      setState(artifact ? 'error' : 'empty');
      setError(
        artifact
          ? 'Browser preview supports STEP, STL and 3MF display artifacts.'
          : '',
      );
      return;
    }

    const viewerHost = host;
    let disposed = false;
    let frame = 0;
    let model: Object3D | undefined;
    let references: ReturnType<typeof referenceVisibility> | undefined;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const scene = new Scene();
    const camera = new PerspectiveCamera(32, 1, 0.1, 100_000);
    camera.up.set(0, 0, 1);
    const renderer = new WebGLRenderer({
      alpha: true,
      antialias: true,
      canvas,
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.setClearAlpha(0);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = !reduceMotion;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;

    const computedStyles = getComputedStyle(document.documentElement);
    const gridColor =
      computedStyles.getPropertyValue('--color-canvas-grid').trim() || '#e8e8e8';
    const centerColor =
      computedStyles.getPropertyValue('--color-rule-strong').trim() || '#a1a1a1';
    const grid = createViewerGrid(gridColor, centerColor);
    scene.add(grid.mesh);

    const ambient = new AmbientLight(0xffffff, 1.7);
    const key = new DirectionalLight(0xffffff, 2.8);
    key.position.set(5, -6, 9);
    const fill = new DirectionalLight(0xdcecff, 1.1);
    fill.position.set(-6, 4, 3);
    scene.add(ambient, key, fill);

    function draw(): void {
      if (disposed) return;
      const viewDistance = Math.max(camera.position.distanceTo(controls.target), Math.abs(camera.position.z), 1);
      const far = viewDistance * 20;
      if (camera.far !== far) {
        camera.far = far;
        camera.updateProjectionMatrix();
      }
      grid.update(camera, viewDistance, viewerHost.clientHeight);
      renderer.render(scene, camera);
    }

    function animate(): void {
      if (disposed) return;
      controls.update();
      draw();
      frame = requestAnimationFrame(animate);
    }

    function resize(): void {
      const width = Math.max(1, viewerHost.clientWidth);
      const height = Math.max(1, viewerHost.clientHeight);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      if (reduceMotion) draw();
    }

    function fit(direction = directionForView('isometric')): void {
      if (!model) return;
      const modelBounds = new Box3().setFromObject(model);
      if (modelBounds.isEmpty()) return;
      const center = modelBounds.getCenter(new Vector3());
      const size = modelBounds.getSize(new Vector3());
      const radius = Math.max(size.x, size.y, size.z, 1);
      const distance = radius / Math.tan((camera.fov * Math.PI) / 360) * 0.78;
      controls.target.copy(center);
      camera.position.copy(center).add(direction.clone().multiplyScalar(distance));
      camera.near = Math.max(distance / 1_000, 0.01);
      camera.far = distance * 20;
      camera.updateProjectionMatrix();
      controls.update();
      draw();
    }

    controllerRef.current = {
      fit: () => fit(),
      setView: (view) => fit(directionForView(view)),
      setReferencesHidden: (hidden) => {
        if (!model || !references) return;
        references.setHidden(hidden);
        setTriangles(triangleCount(model));
        draw();
      },
    };

    const observer = new ResizeObserver(resize);
    observer.observe(viewerHost);
    controls.addEventListener('change', draw);
    resize();
    if (!reduceMotion) frame = requestAnimationFrame(animate);

    const controller = new AbortController();
    setBounds(undefined);
    setTriangles(0);
    setState('loading');
    setError('');
    void fetch(artifact.format === 'step' ? stepPreviewUrl(artifact.url, artifact.sha256) : artifact.url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Unable to prepare model (${String(response.status)})`);
        return response.arrayBuffer();
      })
      .then((buffer) => parseModel(artifact, buffer))
      .then((loaded) => {
        if (disposed) {
          disposeTree(loaded);
          return;
        }
        const root = new Group();
        root.name = artifact.name;
        root.add(loaded);
        model = root;
        scene.add(root);
        if (artifact.format === 'step') {
          references = referenceVisibility(root);
          references.setHidden(hideReferencesRef.current);
          setReferenceComponents(references.info);
        }
        setBounds(new Box3().setFromObject(root).getSize(new Vector3()));
        setTriangles(triangleCount(root));
        fit();
        setState('ready');
      })
      .catch((reason: unknown) => {
        if (disposed || (reason instanceof DOMException && reason.name === 'AbortError')) {
          return;
        }
        setError(reason instanceof Error ? reason.message : 'The model could not be rendered.');
        setState('error');
      });

    return () => {
      disposed = true;
      controller.abort();
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.removeEventListener('change', draw);
      controls.dispose();
      if (model) disposeTree(model);
      grid.dispose();
      // dispose() releases resources, but does not erase the last rendered frame.
      renderer.clear();
      renderer.dispose();
      controllerRef.current = undefined;
    };
  }, [artifact]);

  const ready = state === 'ready';
  return (
    <section
      aria-label="CAD model viewer"
      className={styles.shell}
      data-viewer-status={state}
    >
      <div className={styles.stage} ref={hostRef}>
        <canvas
          aria-hidden={!ready}
          aria-label="Interactive 3D preview. Drag to orbit, scroll to zoom."
          className={styles.canvas}
          ref={canvasRef}
          tabIndex={ready ? 0 : -1}
        />
        <div className={styles.stageTools} data-plates={Boolean(plateNavigation)}>
          <div className={styles.selectionTools} aria-label="Selection mode" role="group">
            <ToolButton disabled={!ready} onClick={() => undefined} pressed={ready}>
              Face
            </ToolButton>
            <ToolButton disabled onClick={() => undefined}>Edge</ToolButton>
            <ToolButton disabled onClick={() => undefined}>Point</ToolButton>
            <ToolButton disabled={!ready} onClick={() => undefined}>Orbit</ToolButton>
          </div>
          {plateNavigation ? (
            <div
              aria-label={plateNavigation.label}
              className={styles.plateTools}
              onKeyDown={(event) => {
                const move = event.key === 'ArrowLeft' ? plateNavigation.onPrevious
                  : event.key === 'ArrowRight' ? plateNavigation.onNext : undefined;
                if (!move) return;
                event.preventDefault();
                move();
              }}
              role="group"
            >
              <ToolButton disabled={!plateNavigation.onPrevious} label={plateNavigation.previousLabel} onClick={plateNavigation.onPrevious}>
                <svg aria-hidden="true" fill="none" viewBox="0 0 16 16"><path d="m10 3-5 5 5 5" /></svg>
              </ToolButton>
              <span aria-atomic="true" aria-live="polite" className={styles.platePosition}>{plateNavigation.positionLabel}</span>
              <ToolButton disabled={!plateNavigation.onNext} label={plateNavigation.nextLabel} onClick={plateNavigation.onNext}>
                <svg aria-hidden="true" fill="none" viewBox="0 0 16 16"><path d="m6 3 5 5-5 5" /></svg>
              </ToolButton>
            </div>
          ) : null}
          <div className={styles.viewTools} aria-label="Camera views" role="group">
            <ToolButton disabled={!ready} onClick={() => controllerRef.current?.fit()}>
              Fit
            </ToolButton>
            <ToolButton
              disabled={!ready}
              onClick={() => controllerRef.current?.setView('isometric')}
            >
              ISO
            </ToolButton>
            <ToolButton
              disabled={!ready}
              onClick={() => controllerRef.current?.setView('front')}
            >
              Front
            </ToolButton>
            <ToolButton
              disabled={!ready}
              onClick={() => controllerRef.current?.setView('top')}
            >
              Top
            </ToolButton>
          </div>
        </div>

        {state !== 'ready' && artifact?.previewImageUrl ? <img className={styles.previewImage} src={artifact.previewImageUrl} alt="CAD preview" /> : null}
        {state === 'empty' ? (
          <StatePanel
            detail="Load a run with a STEP, STL or 3MF preview artifact."
            title="No model loaded"
            tone="empty"
          />
        ) : null}
        {state === 'loading' ? (
          <StatePanel
            detail="Large meshes can take a moment to prepare."
            title="Loading geometry"
            tone="loading"
          />
        ) : null}
        {state === 'error' ? (
          <StatePanel detail={error} title="Model load failed" tone="error" />
        ) : null}

        {ready && bounds ? (
          <footer className={styles.readout}>
            <span>
              {[bounds.x, bounds.y, bounds.z].map((value) => value.toFixed(1)).join(' × ')} mm
            </span>
            <span>{formatBytes(artifact?.size ?? 0)}</span>
          </footer>
        ) : null}
      </div>
    </section>
  );
}
