import {
  Color,
  DoubleSide,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Vector2,
  type PerspectiveCamera,
} from 'three';

/** A world-aligned ground grid whose faded boundary always follows the camera. */
export function createViewerGrid(lineColor: string, axisColor: string) {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    toneMapped: false,
    uniforms: {
      lineColor: { value: new Color(lineColor) },
      axisColor: { value: new Color(axisColor) },
      cameraXY: { value: new Vector2() },
      cellSize: { value: 10 },
      levelBlend: { value: 0 },
      fadeDistance: { value: 1 },
    },
    vertexShader: `
      varying vec2 worldXY;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        worldXY = worldPosition.xy;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 lineColor;
      uniform vec3 axisColor;
      uniform vec2 cameraXY;
      uniform float cellSize;
      uniform float levelBlend;
      uniform float fadeDistance;
      varying vec2 worldXY;

      float gridLines(float spacing) {
        vec2 cells = worldXY / spacing;
        vec2 footprint = max(fwidth(cells), vec2(0.000001));
        vec2 distanceToLine = abs(fract(cells - 0.5) - 0.5) / footprint;
        vec2 lines = 1.0 - min(distanceToLine, vec2(1.0));
        // Fade lines that are too dense to resolve at shallow viewing angles.
        lines *= 1.0 - smoothstep(vec2(0.25), vec2(0.5), footprint);
        return max(lines.x, lines.y);
      }

      void main() {
        float grid = mix(gridLines(cellSize), gridLines(cellSize * 10.0), levelBlend);
        vec2 axisDistance = abs(worldXY) / max(fwidth(worldXY), vec2(0.000001));
        float axis = 1.0 - min(min(axisDistance.x, axisDistance.y), 1.0);
        float fade = 1.0 - smoothstep(fadeDistance * 0.3, fadeDistance, distance(worldXY, cameraXY));
        float opacity = max(grid * 0.9, axis * 0.7) * fade;
        if (opacity < 0.002) discard;
        gl_FragColor = vec4(mix(lineColor, axisColor, axis), opacity);
        #include <colorspace_fragment>
      }
    `,
  });
  const geometry = new PlaneGeometry(2, 2);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'Infinite ground grid';
  mesh.position.z = -0.01;
  mesh.frustumCulled = false;

  return {
    mesh,
    update(camera: PerspectiveCamera, viewDistance: number, viewportHeight: number) {
      const fadeDistance = Math.max(viewDistance, 1) * 8;
      const unitsPerPixel = 2 * viewDistance * Math.tan(camera.fov * Math.PI / 360) /
        Math.max(viewportHeight, 1);
      const level = Math.log10(Math.max(unitsPerPixel * 32, 0.000001));
      const baseLevel = Math.floor(level);
      material.uniforms.cellSize!.value = 10 ** baseLevel;
      material.uniforms.levelBlend!.value = level - baseLevel;
      material.uniforms.fadeDistance!.value = fadeDistance;
      material.uniforms.cameraXY!.value.set(camera.position.x, camera.position.y);
      mesh.position.set(camera.position.x, camera.position.y, -0.01);
      mesh.scale.set(fadeDistance, fadeDistance, 1);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
