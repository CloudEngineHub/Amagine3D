import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Box3, PerspectiveCamera, Plane, Raycaster, Vector2, Vector3 } from 'three';

import { createViewerGrid } from '../src/lib/viewer-grid.ts';

test('grid covers the visible ground after large zoom and pan changes', () => {
  const grid = createViewerGrid('#e8e8e8', '#a1a1a1');
  const camera = new PerspectiveCamera(32, 2, 0.1, 100_000);
  camera.up.set(0, 0, 1);
  const raycaster = new Raycaster();
  const ground = new Plane(new Vector3(0, 0, 1), 0.01);
  try {
    for (const { zoom, offset } of [
      { zoom: 1, offset: new Vector3() },
      { zoom: 50, offset: new Vector3(50_000, -80_000, 0) },
      { zoom: 0.05, offset: new Vector3(-100_000, 120_000, 0) },
    ]) {
      const target = new Vector3(0, 0, 30).add(offset);
      camera.position.copy(target).add(new Vector3(240, -280, 320).multiplyScalar(zoom));
      camera.lookAt(target);
      camera.updateMatrixWorld(true);
      const distance = Math.max(camera.position.distanceTo(target), Math.abs(camera.position.z), 1);
      grid.update(camera, distance, 800);
      grid.mesh.updateMatrixWorld(true);
      const bounds = new Box3().setFromObject(grid.mesh).expandByScalar(0.000001);
      for (const x of [-1, 0, 1]) {
        for (const y of [-1, 0, 1]) {
          raycaster.setFromCamera(new Vector2(x, y), camera);
          const point = raycaster.ray.intersectPlane(ground, new Vector3());
          assert.ok(point, 'visible ground should intersect each viewport ray');
          assert.ok(bounds.containsPoint(point), 'grid must extend past the viewport');
          assert.ok(Math.hypot(point.x - camera.position.x, point.y - camera.position.y) < grid.mesh.scale.x,
            'visible ground should be inside the faded boundary');
        }
      }
    }
  } finally {
    grid.dispose();
  }
});
