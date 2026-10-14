import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { resolveArtifactPath } from './artifacts.ts';

const projectRoot = resolve(import.meta.dirname, '..');
const runtime = join(projectRoot, 'skills', 'a3d-public');
const jobs = new Map<string, Promise<Buffer>>();
const MAX_BYTES = 64 * 1024 * 1024;
const execute = promisify(execFile);
const pythonExecutable = () => process.env.AMAGINE3D_PYTHON?.trim() || join(projectRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

async function runtimeVersion(): Promise<string> {
  const { stdout } = await execute(pythonExecutable(), ['-c', 'import importlib.metadata as m,json,sys; print(json.dumps({"python":sys.version,"executable":sys.executable,"libraries":{n:m.version(n) for n in ["build123d","numpy","trimesh","pillow"]},"ocp":{d.metadata["Name"]:d.version for d in m.distributions() if "ocp" in d.metadata["Name"].lower()}},sort_keys=True))'], { timeout: 5000, maxBuffer: 16 * 1024 });
  return stdout;
}

async function fingerprint(root: string, model: string): Promise<string> {
  const hash = createHash('sha256').update(model);
  const add = async (path: string) => hash.update(await readFile(path));
  await add(model);
  for (const name of ['display_step.py', 'display_normals.py', 'geometry_binding.py', 'brep_tessellation.py', 'export_audit.py']) await add(join(runtime, name));
  await add(join(projectRoot, 'requirements.txt'));
  hash.update(await runtimeVersion());
  const descriptors = [model + '.scene.json', ...(await readdir(dirname(model))).filter((name) => name.endsWith('_cad-stage.json')).map((name) => join(dirname(model), name))];
  for (const path of descriptors) {
    let bytes: Buffer;
    try { bytes = await readFile(path); } catch { continue; }
    const doc = JSON.parse(bytes.toString('utf8'));
    if (path !== model + '.scene.json' && !Object.values(doc.artifacts ?? {}).some((ref: unknown) => (ref as { path?: string }).path === model)) continue;
    hash.update(bytes);
    for (const obj of doc.objects ?? []) {
      const ref = obj.step ?? doc.artifacts?.[obj.stepArtifact];
      if (!ref) continue;
      const local = resolve(root, ref.path);
      const candidate = await resolveArtifactPath(root, relative(root, local));
      if (!candidate || createHash('sha256').update(await readFile(candidate)).digest('hex') !== ref.sha256) throw new Error('STEP preview inputs changed.');
      hash.update(ref.sha256);
    }
  }
  return hash.digest('hex');
}

export async function createStepPreview(root: string, path: string, expectedSha?: string): Promise<Buffer> {
  if (!/\.st(?:ep|p)$/iu.test(path)) throw new Error('A STEP file is required.');
  const model = await resolveArtifactPath(root, path);
  if (!model) throw new Error('STEP artifact not found.');
  const digest = createHash('sha256').update(await readFile(model)).digest('hex');
  if (expectedSha && expectedSha !== digest) throw new Error('STEP revision changed. Refresh the model.');
  const key = await fingerprint(root, model);
  const directory = join(root, '.step-preview-cache');
  const destination = join(directory, key + '.json');
  try {
    if ((await stat(destination)).size > MAX_BYTES) throw new Error('Preview exceeds the size limit.');
    return await readFile(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const jobKey = root + ':' + key;
  if (jobs.has(jobKey)) return jobs.get(jobKey)!;
  if (jobs.size >= 4) throw new Error('Preview queue is busy. Try again shortly.');
  const job = (async () => {
    await mkdir(directory, { recursive: true });
    const temporary = destination + '.pending';
    try {
      await new Promise<void>((done, fail) => {
        const python = pythonExecutable();
        const child = spawn(python, [join(runtime, 'display_step.py'), model, '--out', temporary], { cwd: root, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new Error('STEP preview timed out.')); }, 120_000);
        const receive = (bytes: Buffer) => {
          output += bytes.toString('utf8');
          if (output.length > 64 * 1024) { child.kill('SIGKILL'); fail(new Error('Preview process output exceeded its limit.')); }
        };
        child.stdout.on('data', receive);
        child.stderr.on('data', receive);
        child.on('error', (error) => { clearTimeout(timer); fail(error); });
        child.on('close', (code) => { clearTimeout(timer); code === 0 ? done() : fail(new Error(output.slice(-1600) || 'STEP preview failed.')); });
      });
      if (await fingerprint(root, model) !== key) throw new Error('STEP inputs changed during preview.');
      if ((await stat(temporary)).size > MAX_BYTES) throw new Error('Preview exceeds the size limit.');
      const bytes = await readFile(temporary);
      const data = JSON.parse(bytes.toString('utf8'));
      if (data.schema !== 'a3d-step-preview/v1' || data.inputs?.step?.sha256 !== digest) throw new Error('Invalid preview provenance.');
      await rename(temporary, destination);
      return bytes;
    } finally { await rm(temporary, { force: true }); }
  })();
  jobs.set(jobKey, job);
  try { return await job; } finally { jobs.delete(jobKey); }
}
