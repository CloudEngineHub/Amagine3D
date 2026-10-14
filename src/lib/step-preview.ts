import { BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshStandardMaterial } from 'three';

interface StepObject {
  id: string;
  positions: number[];
  indices: number[];
  normals: number[];
  appearance: { baseColor: string; metallic: number; roughness: number };
  metadata: { role: string; physicalFeatureRef?: string; ownerPart?: string; regionId?: string };
}

export function parseStepPreview(input: unknown, expectedSha?: string): Group {
  const data = input as { schema?: string; units?: string; up?: string; inputs?: { step?: { sha256?: string } }; objects?: StepObject[] };
  if (data?.schema !== 'a3d-step-preview/v1' || data.units !== 'mm' || data.up !== 'Z' || !Array.isArray(data.objects) || !data.objects.length || data.objects.length > 2000 || (expectedSha && data.inputs?.step?.sha256 !== expectedSha)) throw new Error('Invalid or outdated STEP preview.');
  const ids = new Set<string>();
  for (const obj of data.objects) {
    if (typeof obj.id !== 'string' || !obj.id || ids.has(obj.id) || !Array.isArray(obj.positions) || !Array.isArray(obj.indices) || !Array.isArray(obj.normals) || !obj.positions.length || obj.positions.length % 3 || obj.normals.length !== obj.positions.length || !obj.indices.length || obj.indices.length % 3 || !obj.positions.every((x) => Number.isFinite(x) && Math.abs(x) <= 3.4e38) || !obj.normals.every(Number.isFinite) || !obj.indices.every((i) => Number.isInteger(i) && i >= 0 && i < obj.positions.length / 3) || !/^#[\da-f]{6}$/iu.test(obj.appearance?.baseColor) || ![obj.appearance.metallic, obj.appearance.roughness].every((x) => Number.isFinite(x) && x >= 0 && x <= 1) || !['manufactured', 'display-only', 'unclassified', 'proposed-part', 'manufactured-part'].includes(obj.metadata?.role)) throw new Error('Invalid STEP preview geometry.');
    ids.add(obj.id);
    for (let i = 0; i < obj.normals.length; i += 3) {
      if (Math.abs(Math.hypot(obj.normals[i]!, obj.normals[i + 1]!, obj.normals[i + 2]!) - 1) > 1e-4) throw new Error('Invalid STEP preview normals.');
    }
  }
  const root = new Group();
  for (const obj of data.objects) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(obj.positions), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(obj.normals), 3));
    geometry.setIndex(new BufferAttribute(new Uint32Array(obj.indices), 1));
    const mesh = new Mesh(geometry, new MeshStandardMaterial({ color: new Color(obj.appearance.baseColor), metalness: obj.appearance.metallic, roughness: obj.appearance.roughness }));
    mesh.name = obj.id;
    mesh.userData.amagine3d = obj.metadata;
    root.add(mesh);
  }
  return root;
}

export function stepPreviewUrl(url: string, sha?: string): string {
  const [path, query] = url.split('?');
  const params = new URLSearchParams(query);
  if (sha) params.set('sha256', sha);
  return path!.replace(/\/file$/u, '/step-preview') + '?' + params.toString();
}
